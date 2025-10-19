import * as fs from "fs";
import { promises as fsp } from "fs";
import * as path from "path";
import { PullRequest } from "./pr-data";

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
};

export async function analyze(): Promise<void> {
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
    for (const pr of all) {
        for (const rv of pr.latestReviews || []) {
            const key = rv.author?.login ?? "unknown";
            reviewCountByUser.set(key, (reviewCountByUser.get(key) || 0) + 1);
        }
    }
    const mostReviews = [...reviewCountByUser.entries()].sort((a, b) => b[1] - a[1])[0];

    // PR with most changes
    const mostAdditions = all.reduce<PRWithRepo>((max, pr) => (pr.additions > max.additions ? pr : max), all[0]!);
    const mostDeletions = all.reduce<PRWithRepo>((max, pr) => (pr.deletions > max.deletions ? pr : max), all[0]!);
    const mostChangedFiles = all.reduce<PRWithRepo>(
        (max, pr) => (pr.changedFiles > max.changedFiles ? pr : max),
        all[0]!
    );

    // file with most changes
    const fileAgg = new Map<string, FileAgg>();
    for (const pr of all) {
        const seenInThisPr = new Set<string>();
        for (const f of pr.files || []) {
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
            } as RepoBucket;
            byRepo.set(pr.__repo, bucket);
        }
        bucket.prs.push(pr);
        // assignees count
        for (const a of pr.assignees) {
            const k = a?.login ?? "unknown";
            bucket.prCountByAssignee.set(k, (bucket.prCountByAssignee.get(k) || 0) + 1);
        }
        // reviews count
        for (const rv of pr.latestReviews || []) {
            const k = rv.author?.login ?? "unknown";
            bucket.reviewCountByUser.set(k, (bucket.reviewCountByUser.get(k) || 0) + 1);
        }
        // file agg
        const seen = new Set<string>();
        for (const f of pr.files || []) {
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
        // tops
        bucket.topAdd = !bucket.topAdd || pr.additions > bucket.topAdd.additions ? pr : bucket.topAdd;
        bucket.topDel = !bucket.topDel || pr.deletions > bucket.topDel.deletions ? pr : bucket.topDel;
        bucket.topFiles = !bucket.topFiles || pr.changedFiles > bucket.topFiles.changedFiles ? pr : bucket.topFiles;

        byRepo.set(pr.__repo, bucket);
    }

    // Build Markdown report
    const lines: string[] = [];
    lines.push(`# Repository Stats\n`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push("");
    lines.push(`## Overall\n`);
    if (mostPRs) lines.push(`- Most PRs: ${mostPRs[0]} (${mostPRs[1]})`);
    if (mostReviews) lines.push(`- Most reviews: ${mostReviews[0]} (${mostReviews[1]})`);
    const prLabel = (pr: PRWithRepo | PullRequest) => `${(pr as any).title} ([#${pr.number}](${pr.url}))`;
    lines.push("");
    lines.push(`### PRs with most changes\n`);
    if (mostAdditions) lines.push(`- Additions: ${mostAdditions.additions} — ${prLabel(mostAdditions)}>`);
    if (mostDeletions) lines.push(`- Deletions: ${mostDeletions.deletions} — ${prLabel(mostDeletions)}>`);
    if (mostChangedFiles)
        lines.push(`- Changed files: ${mostChangedFiles.changedFiles} — ${prLabel(mostChangedFiles)}>`);
    lines.push("");
    lines.push(`### Files with most changes\n`);
    if (topByAdditions) lines.push(`- Additions: ${topByAdditions[0]} (${topByAdditions[1].additions})`);
    if (topByDeletions) lines.push(`- Deletions: ${topByDeletions[0]} (${topByDeletions[1].deletions})`);
    if (topByPRs) lines.push(`- Most PRs touching: ${topByPRs[0]} (${topByPRs[1].prs})`);
    if (topPair) lines.push("");
    if (topPair) lines.push(`### Top author-reviewer pair\n`);
    if (topPair) lines.push(`- ${topPair.users[0]} & ${topPair.users[1]} (${topPair.count} reviews)`);

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
        if (bucket.topAdd) lines.push(`- Most additions: ${bucket.topAdd.additions} — ${prLabel(bucket.topAdd)}`);
        if (bucket.topDel) lines.push(`- Most deletions: ${bucket.topDel.deletions} — ${prLabel(bucket.topDel)}`);
        if (bucket.topFiles)
            lines.push(`- Most changed files: ${bucket.topFiles.changedFiles} — ${prLabel(bucket.topFiles)}`);
        const fa = bucket.fileAgg;
        const rAdd = [...fa.entries()].sort((a, b) => b[1].additions - a[1].additions)[0];
        const rDel = [...fa.entries()].sort((a, b) => b[1].deletions - a[1].deletions)[0];
        const rPRs = [...fa.entries()].sort((a, b) => b[1].prs - a[1].prs)[0];
        if (rAdd) lines.push(`- File additions: ${rAdd[0]} (${rAdd[1].additions})`);
        if (rDel) lines.push(`- File deletions: ${rDel[0]} (${rDel[1].deletions})`);
        if (rPRs) lines.push(`- File PRs touching: ${rPRs[0]} (${rPRs[1].prs})`);
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
