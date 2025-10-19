import * as fs from "fs";
import { promises as fsp } from "fs";
import * as path from "path";
import { PullRequest } from "./pr-data";

type PRWithRepo = PullRequest & { __repo: string };

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
    type FileAgg = { additions: number; deletions: number; prs: number };
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

    // Output
    console.log("\n=== Analysis ===");
    if (mostPRs) console.log(`Most PRs: ${mostPRs[0]} with ${mostPRs[1]} PRs`);
    if (mostReviews) console.log(`Most reviews: ${mostReviews[0]} with ${mostReviews[1]} approvals`);

    const prLabel = (pr: PRWithRepo | PullRequest) => `${(pr as any).title} (#${pr.number})`;
    console.log("\nPRs with most changes:");
    if (mostAdditions)
        console.log(`- Additions: ${mostAdditions.additions} in ${prLabel(mostAdditions)} ${mostAdditions.url}`);
    if (mostDeletions)
        console.log(`- Deletions: ${mostDeletions.deletions} in ${prLabel(mostDeletions)} ${mostDeletions.url}`);
    if (mostChangedFiles)
        console.log(
            `- Changed files: ${mostChangedFiles.changedFiles} in ${prLabel(mostChangedFiles)} ${mostChangedFiles.url}`
        );

    console.log("\nFiles with most changes:");
    if (topByAdditions) console.log(`- Additions: ${topByAdditions[0]} with ${topByAdditions[1].additions} additions`);
    if (topByDeletions) console.log(`- Deletions: ${topByDeletions[0]} with ${topByDeletions[1].deletions} deletions`);
    if (topByPRs) console.log(`- PRs touching: ${topByPRs[0]} in ${topByPRs[1].prs} PRs`);

    if (topPair)
        console.log(`\nTop author-reviewer pair: ${topPair.users[0]} & ${topPair.users[1]} (${topPair.count} reviews)`);
}
