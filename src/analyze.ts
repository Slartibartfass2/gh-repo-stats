import * as fs from "fs";
import { promises as fsp } from "fs";
import * as path from "path";
import { PullRequest } from "./pr-data";
import { loadIgnoreRules, shouldIgnoreFile } from "./ignore";

type PRWithRepo = PullRequest & { __repo: string };
type FileAgg = { additions: number; deletions: number; prs: number };
type RepoBucket = {
    prs: PRWithRepo[];
    prCountByAssignee: Map<string, number>;
    reviewCountByUser: Map<string, number>;
    topAdd?: PRWithRepo;
    topDel?: PRWithRepo;
    topFiles?: PRWithRepo;
    fileAgg: Map<string, FileAgg>;
    topPair?: { users: string[]; count: number };
    totalLoc?: number;
};

export async function analyze(): Promise<void> {
    const ignoreRules = loadIgnoreRules();
    const statsDir = path.resolve(process.cwd(), "stats");
    if (!fs.existsSync(statsDir)) {
        console.error(`No stats directory found at ${statsDir}. Run 'npm start -- fetch' first.`);
        process.exitCode = 1;
        return;
    }

    const files = (await fsp.readdir(statsDir)).filter((f) => f.startsWith("pr-data-") && f.endsWith(".json"));
    if (files.length === 0) {
        console.error(`No stats files found in ${statsDir}. Run 'npm start -- fetch' first.`);
        process.exitCode = 1;
        return;
    }

    const all: PRWithRepo[] = [];
    for (const fname of files) {
        const repoId = fname
            .replace(/^pr-data-/, "")
            .replace(/\.json$/, "")
            .replace(/_/g, "/");
        try {
            const content = await fsp.readFile(path.join(statsDir, fname), "utf8");
            const arr = JSON.parse(content) as PullRequest[];
            for (const pr of arr) all.push(Object.assign({ __repo: repoId }, pr));
        } catch (e: any) {
            console.warn(`Failed to read ${fname}: ${e.message}`);
        }
    }

    if (all.length === 0) {
        console.error(`No PR data found in ${statsDir}.`);
        process.exitCode = 1;
        return;
    }

    // person with most PRs (by assignee)
    const prCountByAssignee = new Map<string, number>();
    for (const pr of all) {
        for (const assignee of pr.assignees) {
            const key = assignee?.login ?? "unknown";
            prCountByAssignee.set(key, (prCountByAssignee.get(key) || 0) + 1);
        }
    }
    const mostPRs = [...prCountByAssignee.entries()].sort((a, b) => b[1] - a[1])[0];

    // person with most reviews (count APPROVED reviews filtered in fetch)
    const reviewCountByUser = new Map<string, number>();
    // biggest reviews (by LOC additions+deletions) overall
    const reviewLocTotalByUser = new Map<string, number>();
    const reviewMaxLocByUser = new Map<string, { loc: number; pr: PRWithRepo }>();
    for (const pr of all) {
        // Helper to compute PR LOC based only on non-ignored files if files array is present;
        // otherwise fall back to additions+deletions totals.
        const effectivePrLoc = (() => {
            if (Array.isArray(pr.files) && pr.files.length > 0) {
                let add = 0,
                    del = 0;
                for (const f of pr.files) {
                    if (shouldIgnoreFile(pr.__repo, f.path, ignoreRules)) continue;
                    add += f.additions || 0;
                    del += f.deletions || 0;
                }
                return add + del;
            }
            return (pr.additions || 0) + (pr.deletions || 0);
        })();
        const reviewersInThisPR = new Set<string>();
        for (const rv of pr.latestReviews || []) {
            const key = rv.author?.login ?? "unknown";
            reviewCountByUser.set(key, (reviewCountByUser.get(key) || 0) + 1);
            // dedupe LOC accumulation per reviewer per PR
            if (!reviewersInThisPR.has(key)) {
                reviewersInThisPR.add(key);
                reviewLocTotalByUser.set(key, (reviewLocTotalByUser.get(key) || 0) + effectivePrLoc);
                const prev = reviewMaxLocByUser.get(key);
                if (!prev || effectivePrLoc > prev.loc) reviewMaxLocByUser.set(key, { loc: effectivePrLoc, pr });
            }
        }
    }
    const mostReviews = [...reviewCountByUser.entries()].sort((a, b) => b[1] - a[1])[0];
    const biggestReviewerTotal = [...reviewLocTotalByUser.entries()].sort((a, b) => b[1] - a[1])[0];
    const biggestReviewerSingle = [...reviewMaxLocByUser.entries()].sort((a, b) => b[1].loc - a[1].loc)[0];

    // Helpers to compute effective metrics with ignore rules
    const effectiveAdds = (pr: PRWithRepo): number => {
        if (Array.isArray(pr.files) && pr.files.length > 0) {
            let add = 0;
            for (const f of pr.files) {
                if (shouldIgnoreFile(pr.__repo, f.path, ignoreRules)) continue;
                add += f.additions || 0;
            }
            return add;
        }
        return pr.additions || 0;
    };
    const effectiveDels = (pr: PRWithRepo): number => {
        if (Array.isArray(pr.files) && pr.files.length > 0) {
            let del = 0;
            for (const f of pr.files) {
                if (shouldIgnoreFile(pr.__repo, f.path, ignoreRules)) continue;
                del += f.deletions || 0;
            }
            return del;
        }
        return pr.deletions || 0;
    };
    const effectiveChanged = (pr: PRWithRepo): number => {
        if (Array.isArray(pr.files) && pr.files.length > 0) {
            let count = 0;
            for (const f of pr.files) {
                if (shouldIgnoreFile(pr.__repo, f.path, ignoreRules)) continue;
                count += 1;
            }
            return count;
        }
        return pr.changedFiles || 0;
    };

    // Compute effective LOC helper (adds + dels across non-ignored files when available)
    const effectiveLoc = (pr: PRWithRepo): number => {
        return effectiveAdds(pr) + effectiveDels(pr);
    };
    const mostAdditions = all.reduce<PRWithRepo>(
        (max, pr) => (effectiveAdds(pr) > effectiveAdds(max) ? pr : max),
        all[0]!
    );
    const mostDeletions = all.reduce<PRWithRepo>(
        (max, pr) => (effectiveDels(pr) > effectiveDels(max) ? pr : max),
        all[0]!
    );
    const mostChangedFiles = all.reduce<PRWithRepo>(
        (max, pr) => (effectiveChanged(pr) > effectiveChanged(max) ? pr : max),
        all[0]!
    );

    // file with most changes
    const fileAgg = new Map<string, FileAgg>();
    for (const pr of all) {
        const seenInThisPr = new Set<string>();
        for (const f of pr.files || []) {
            if (shouldIgnoreFile(pr.__repo, f.path, ignoreRules)) continue;
            const key = f.path;
            const cur = fileAgg.get(key) || { additions: 0, deletions: 0, prs: 0 };
            cur.additions += f.additions || 0;
            cur.deletions += f.deletions || 0;
            if (!seenInThisPr.has(key)) {
                cur.prs += 1;
                seenInThisPr.add(key);
            }
            fileAgg.set(key, cur);
        }
    }
    const topByAdditions = [...fileAgg.entries()].sort((a, b) => b[1].additions - a[1].additions)[0];
    const topByDeletions = [...fileAgg.entries()].sort((a, b) => b[1].deletions - a[1].deletions)[0];
    const topByPRs = [...fileAgg.entries()].sort((a, b) => b[1].prs - a[1].prs)[0];

    // pair of people who work most together (author-reviewer relation) – undirected pair
    const pairCounts = new Map<string, number>();
    for (const pr of all) {
        const a = pr.author?.login;
        for (const rv of pr.latestReviews || []) {
            const r = rv.author?.login;
            if (!a || !r || a === r) continue;
            const [u1, u2] = [a, r].sort();
            const key = `${u1}|${u2}`;
            pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
        }
    }
    const topPairEntry = [...pairCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const topPair = topPairEntry ? { users: topPairEntry[0].split("|"), count: topPairEntry[1] } : undefined;

    // Lead time to merge (mergedAt - createdAt)
    const parseLeadMs = (pr: PullRequest): number | undefined => {
        if (!pr.createdAt || !pr.mergedAt) return undefined;
        const created = Date.parse(pr.createdAt);
        const merged = Date.parse(pr.mergedAt);
        if (!isFinite(created) || !isFinite(merged)) return undefined;
        const ms = merged - created;
        return ms >= 0 ? ms : undefined;
    };
    const humanizeDuration = (ms: number): string => {
        const secTotal = Math.floor(ms / 1000);
        const days = Math.floor(secTotal / 86400);
        const hours = Math.floor((secTotal % 86400) / 3600);
        const minutes = Math.floor((secTotal % 3600) / 60);
        const seconds = secTotal % 60;
        const parts: string[] = [];
        if (days) parts.push(`${days}d`);
        if (hours || days) parts.push(`${hours}h`);
        if (minutes || hours || days) parts.push(`${minutes}m`);
        if (!days && !hours && minutes === 0) parts.push(`${seconds}s`);
        return parts.join(" ");
    };

    // Overall LOC metrics (per-PR, not per-assignee)
    const effectiveLocs = all.map((pr) => effectiveLoc(pr));
    const totalLocAll = effectiveLocs.reduce((s, v) => s + v, 0);
    const avgLocAll = effectiveLocs.length > 0 ? Math.round(totalLocAll / effectiveLocs.length) : 0;

    type LeadStat = { pr: PRWithRepo; ms: number } | undefined;
    const overallLead: { shortest: LeadStat; longest: LeadStat } = { shortest: undefined, longest: undefined };
    for (const pr of all) {
        const ms = parseLeadMs(pr);
        if (ms == null) continue;
        if (!overallLead.shortest || ms < overallLead.shortest.ms) overallLead.shortest = { pr, ms };
        if (!overallLead.longest || ms > overallLead.longest.ms) overallLead.longest = { pr, ms };
    }

    // Per-repo aggregation
    const byRepo = new Map<string, RepoBucket>();

    for (const pr of all) {
        let bucket = byRepo.get(pr.__repo);
        if (!bucket) {
            bucket = {
                prs: [],
                prCountByAssignee: new Map<string, number>(),
                reviewCountByUser: new Map<string, number>(),
                fileAgg: new Map<string, FileAgg>(),
                // per-repo biggest reviews
                // total LOC reviewed per user
                // and max single-PR review per user
                // We'll attach them dynamically
            } as RepoBucket;
            byRepo.set(pr.__repo, bucket);
        }
        // accumulate effective LOC per repo and track largest PR
        const prEffectiveLoc = effectiveLoc(pr as PRWithRepo);
        bucket.totalLoc = (bucket.totalLoc || 0) + prEffectiveLoc;
        bucket.prs.push(pr);
        // assignees count
        for (const a of pr.assignees) {
            const k = a?.login ?? "unknown";
            bucket.prCountByAssignee.set(k, (bucket.prCountByAssignee.get(k) || 0) + 1);
        }
        // reviews count + biggest reviews per repo (by LOC)
        const prLoc = (() => {
            if (Array.isArray(pr.files) && pr.files.length > 0) {
                let add = 0,
                    del = 0;
                for (const f of pr.files) {
                    if (shouldIgnoreFile(pr.__repo, f.path, ignoreRules)) continue;
                    add += f.additions || 0;
                    del += f.deletions || 0;
                }
                return add + del;
            }
            return (pr.additions || 0) + (pr.deletions || 0);
        })();
        const seenReviewers = new Set<string>();
        // lazy init maps on bucket as any additions
        const anyBucket: any = bucket as any;
        if (!anyBucket.reviewLocTotalByUser) anyBucket.reviewLocTotalByUser = new Map<string, number>();
        if (!anyBucket.reviewMaxLocByUser)
            anyBucket.reviewMaxLocByUser = new Map<string, { loc: number; pr: PRWithRepo }>();
        for (const rv of pr.latestReviews || []) {
            const k = rv.author?.login ?? "unknown";
            bucket.reviewCountByUser.set(k, (bucket.reviewCountByUser.get(k) || 0) + 1);
            if (!seenReviewers.has(k)) {
                seenReviewers.add(k);
                anyBucket.reviewLocTotalByUser.set(k, (anyBucket.reviewLocTotalByUser.get(k) || 0) + prLoc);
                const prev = anyBucket.reviewMaxLocByUser.get(k);
                if (!prev || prLoc > prev.loc) anyBucket.reviewMaxLocByUser.set(k, { loc: prLoc, pr });
            }
        }
        // file agg
        const seen = new Set<string>();
        for (const f of pr.files || []) {
            if (shouldIgnoreFile(pr.__repo, f.path, ignoreRules)) continue;
            const k = f.path;
            const cur = bucket.fileAgg.get(k) || { additions: 0, deletions: 0, prs: 0 };
            cur.additions += f.additions || 0;
            cur.deletions += f.deletions || 0;
            if (!seen.has(k)) {
                cur.prs += 1;
                seen.add(k);
            }
            bucket.fileAgg.set(k, cur);
        }
        // tops using effective metrics with ignore rules
        bucket.topAdd = !bucket.topAdd || effectiveAdds(pr) > effectiveAdds(bucket.topAdd) ? pr : bucket.topAdd;
        bucket.topDel = !bucket.topDel || effectiveDels(pr) > effectiveDels(bucket.topDel) ? pr : bucket.topDel;
        bucket.topFiles =
            !bucket.topFiles || effectiveChanged(pr) > effectiveChanged(bucket.topFiles) ? pr : bucket.topFiles;

        byRepo.set(pr.__repo, bucket);
    }

    // Assignee LOC stats overall: total and count (number of PRs assigned)
    const assigneeStats = new Map<string, { total: number; count: number }>();
    for (const pr of all) {
        const prLoc = effectiveLoc(pr as PRWithRepo);
        for (const a of pr.assignees || []) {
            const key = a?.login ?? "unknown";
            const cur = assigneeStats.get(key) || { total: 0, count: 0 };
            cur.total += prLoc;
            cur.count += 1;
            assigneeStats.set(key, cur);
        }
    }
    const biggestAssigneeTotal = [...assigneeStats.entries()].sort((a, b) => b[1].total - a[1].total)[0];

    // Build Markdown report
    const lines: string[] = [];
    lines.push(`# Repository Stats\n`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push("");
    lines.push(`## Overall\n`);
    if (mostPRs) lines.push(`- Most PRs: ${mostPRs[0]} (${mostPRs[1]})`);
    if (mostReviews) lines.push(`- Most reviews: ${mostReviews[0]} (${mostReviews[1]})`);
    // Assignee totals and averages overall
    const assigneeOverallSorted = [...assigneeStats.entries()].sort((a, b) => b[1].total - a[1].total);
    if (assigneeOverallSorted.length > 0) {
        lines.push("\n### Assignee LOC (overall)\n");
        for (const [user, stats] of assigneeOverallSorted) {
            const avg = stats.count > 0 ? Math.round(stats.total / stats.count) : 0;
            lines.push(`- ${user}: ${stats.total} LOC total, ${stats.count} PRs, avg ${avg} LOC/PR`);
        }
    }
    const prLabel = (pr: PRWithRepo | PullRequest) => `${(pr as any).title} ([#${pr.number}](${pr.url}))`;
    lines.push("");
    // Overall LOC summary
    lines.push(`### LOC per PR (overall)\n`);
    lines.push(`- Total LOC (effective): ${totalLocAll}`);
    lines.push(`- Average LOC per PR: ${avgLocAll}`);
    // intentionally no "largest PR by LOC" overall line (removed by request)
    lines.push("");
    lines.push(`### PRs with most changes\n`);
    if (mostAdditions) lines.push(`- Additions: ${effectiveAdds(mostAdditions)} — ${prLabel(mostAdditions)}`);
    if (mostDeletions) lines.push(`- Deletions: ${effectiveDels(mostDeletions)} — ${prLabel(mostDeletions)}`);
    if (mostChangedFiles)
        lines.push(`- Changed files: ${effectiveChanged(mostChangedFiles)} — ${prLabel(mostChangedFiles)}`);
    lines.push("");
    lines.push(`### Files with most changes\n`);
    if (topByAdditions) lines.push(`- Additions: ${topByAdditions[0]} (${topByAdditions[1].additions})`);
    if (topByDeletions) lines.push(`- Deletions: ${topByDeletions[0]} (${topByDeletions[1].deletions})`);
    if (topByPRs) lines.push(`- Most PRs touching: ${topByPRs[0]} (${topByPRs[1].prs})`);
    if (topPair) lines.push("");
    if (topPair) lines.push(`### Top author-reviewer pair\n`);
    if (topPair) lines.push(`- ${topPair.users[0]} & ${topPair.users[1]} (${topPair.count} reviews)`);

    // Lead time section (overall)
    lines.push("");
    lines.push(`### Lead time to merge (overall)\n`);
    if (overallLead.shortest)
        lines.push(`- Shortest: ${humanizeDuration(overallLead.shortest.ms)} — ${prLabel(overallLead.shortest.pr)}`);
    if (overallLead.longest)
        lines.push(`- Longest: ${humanizeDuration(overallLead.longest.ms)} — ${prLabel(overallLead.longest.pr)}`);

    // Biggest reviews (overall)
    lines.push("");
    lines.push(`### Biggest reviews (overall by LOC)\n`);
    if (biggestReviewerTotal)
        lines.push(`- Largest total: ${biggestReviewerTotal[0]} (${biggestReviewerTotal[1]} LOC reviewed)`);
    if (biggestReviewerSingle) {
        const pr = biggestReviewerSingle[1].pr;
        const assignees = (pr.assignees || []).map((a) => a?.login || "unknown");
        const assigneesStr = assignees.length > 1 ? `Assignees: ${assignees.join(", ")}` : `Assignee: ${assignees[0]}`;
        lines.push(
            `- Largest single review: ${biggestReviewerSingle[0]} (${biggestReviewerSingle[1].loc} LOC, ${assigneesStr}) — ${prLabel(pr)}`
        );
    }

    // Biggest PRs total as assignee (overall)
    lines.push("");
    lines.push(`### Biggest PRs total (assignee by LOC)\n`);
    if (biggestAssigneeTotal)
        lines.push(`- Largest total as assignee: ${biggestAssigneeTotal[0]} (${biggestAssigneeTotal[1].total} LOC)`);

    // Per-repo sections
    lines.push("");
    lines.push(`## By Repository\n`);
    for (const [repo, bucket] of [...byRepo.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        lines.push(`### ${repo}\n`);
        lines.push(`- Total PRs: ${bucket.prs.length}`);
        const topAssignee = [...bucket.prCountByAssignee.entries()].sort((a, b) => b[1] - a[1])[0];
        const topReviewer = [...bucket.reviewCountByUser.entries()].sort((a, b) => b[1] - a[1])[0];
        if (topAssignee) lines.push(`- Most PRs: ${topAssignee[0]} (${topAssignee[1]})`);
        if (topReviewer) lines.push(`- Most reviews: ${topReviewer[0]} (${topReviewer[1]})`);
        // Per-repo LOC summary
        if (bucket.totalLoc !== undefined) {
            const avgRepo = bucket.prs.length > 0 ? Math.round((bucket.totalLoc || 0) / bucket.prs.length) : 0;
            lines.push(`- Total LOC (effective, repo): ${bucket.totalLoc}`);
            lines.push(`- Average LOC per PR (repo): ${avgRepo}`);
        }
        // Assignee totals & averages per repo
        const repoAssigneeStats = new Map<string, { total: number; count: number }>();
        for (const pr of bucket.prs) {
            const loc = effectiveLoc(pr);
            for (const a of pr.assignees || []) {
                const k = a?.login ?? "unknown";
                const cur = repoAssigneeStats.get(k) || { total: 0, count: 0 };
                cur.total += loc;
                cur.count += 1;
                repoAssigneeStats.set(k, cur);
            }
        }
        const repoAssigneesSorted = [...repoAssigneeStats.entries()].sort((a, b) => b[1].total - a[1].total);
        if (repoAssigneesSorted.length > 0) {
            lines.push("\n- Assignee LOC (repo):");
            for (const [user, stats] of repoAssigneesSorted) {
                const avg = stats.count > 0 ? Math.round(stats.total / stats.count) : 0;
                lines.push(`  - ${user}: ${stats.total} LOC total, ${stats.count} PRs, avg ${avg} LOC/PR`);
            }
        }
        // Lead time per repo
        let repoShortest: LeadStat = undefined;
        let repoLongest: LeadStat = undefined;
        for (const pr of bucket.prs) {
            const ms = parseLeadMs(pr);
            if (ms == null) continue;
            if (!repoShortest || ms < repoShortest.ms) repoShortest = { pr, ms };
            if (!repoLongest || ms > repoLongest.ms) repoLongest = { pr, ms };
        }
        if (repoShortest)
            lines.push(`- Shortest lead time: ${humanizeDuration(repoShortest.ms)} — ${prLabel(repoShortest.pr)}`);
        if (repoLongest)
            lines.push(`- Longest lead time: ${humanizeDuration(repoLongest.ms)} — ${prLabel(repoLongest.pr)}`);
        // Biggest PRs total as assignee (per repo) respecting ignore rules
        const assigneeLocMap = new Map<string, number>();
        for (const pr of bucket.prs) {
            const prLoc = (() => {
                if (Array.isArray(pr.files) && pr.files.length > 0) {
                    let add = 0,
                        del = 0;
                    for (const f of pr.files) {
                        if (shouldIgnoreFile(pr.__repo, f.path, ignoreRules)) continue;
                        add += f.additions || 0;
                        del += f.deletions || 0;
                    }
                    return add + del;
                }
                return (pr.additions || 0) + (pr.deletions || 0);
            })();
            for (const a of pr.assignees || []) {
                const key = a?.login ?? "unknown";
                assigneeLocMap.set(key, (assigneeLocMap.get(key) || 0) + prLoc);
            }
        }
        const repoBiggestAssignee = [...assigneeLocMap.entries()].sort((a, b) => b[1] - a[1])[0];
        if (repoBiggestAssignee)
            lines.push(`- Biggest PRs total (assignee): ${repoBiggestAssignee[0]} (${repoBiggestAssignee[1]} LOC)`);
        if (bucket.topAdd) lines.push(`- Most additions: ${effectiveAdds(bucket.topAdd)} — ${prLabel(bucket.topAdd)}`);
        if (bucket.topDel) lines.push(`- Most deletions: ${effectiveDels(bucket.topDel)} — ${prLabel(bucket.topDel)}`);
        if (bucket.topFiles)
            lines.push(`- Most changed files: ${effectiveChanged(bucket.topFiles)} — ${prLabel(bucket.topFiles)}`);
        const fa = bucket.fileAgg;
        const rAdd = [...fa.entries()].sort((a, b) => b[1].additions - a[1].additions)[0];
        const rDel = [...fa.entries()].sort((a, b) => b[1].deletions - a[1].deletions)[0];
        const rPRs = [...fa.entries()].sort((a, b) => b[1].prs - a[1].prs)[0];
        if (rAdd) lines.push(`- File additions: ${rAdd[0]} (${rAdd[1].additions})`);
        if (rDel) lines.push(`- File deletions: ${rDel[0]} (${rDel[1].deletions})`);
        if (rPRs) lines.push(`- File PRs touching: ${rPRs[0]} (${rPRs[1].prs})`);
        const anyBucket: any = bucket as any;
        const rBiggestTotal = anyBucket.reviewLocTotalByUser
            ? [...anyBucket.reviewLocTotalByUser.entries()].sort((a: any, b: any) => b[1] - a[1])[0]
            : undefined;
        const rBiggestSingle = anyBucket.reviewMaxLocByUser
            ? [...anyBucket.reviewMaxLocByUser.entries()].sort((a: any, b: any) => b[1].loc - a[1].loc)[0]
            : undefined;
        if (rBiggestTotal)
            lines.push(`- Biggest reviews total: ${rBiggestTotal[0]} (${rBiggestTotal[1]} LOC reviewed)`);
        if (rBiggestSingle) {
            const pr = rBiggestSingle[1].pr;
            const assignees = (pr.assignees || []).map((a: any) => a?.login || "unknown");
            const assigneesStr =
                assignees.length > 1 ? `Assignees: ${assignees.join(", ")}` : `Assignee: ${assignees[0]}`;
            lines.push(
                `- Biggest single review: ${rBiggestSingle[0]} (${rBiggestSingle[1].loc} LOC, ${assigneesStr}) — ${prLabel(pr)}`
            );
        }
        lines.push("");
    }

    // Write Stats.md
    await fsp.mkdir(statsDir, { recursive: true });
    const outPath = path.join(statsDir, "Stats.md");
    await fsp.writeFile(outPath, lines.join("\n"), "utf8");

    // Also print a short console summary
    console.log("\n=== Analysis ===");
    if (mostPRs) console.log(`Most PRs: ${mostPRs[0]} with ${mostPRs[1]} PRs`);
    if (mostReviews) console.log(`Most reviews: ${mostReviews[0]} with ${mostReviews[1]} approvals`);
    console.log(`Report written to: ${outPath}`);
}
