import * as fs from "fs";
import { promises as fsp } from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { isAuthorBot, PullRequest } from "./pr-data";

// ---------- Config (edit as needed) ----------
const DEFAULT_USERS = ["Slartibartfass2", "Merseleo", "domienderle", "mowi12", "luca-schlecker"];

const DEFAULT_REPOS = [
    "SE-UUlm/snowballr-frontend",
    "SE-UUlm/snowballr-mock-backend",
    "SE-UUlm/snowballr-backend",
    "SE-UUlm/snowballr-api",
];

const DEFAULT_SINCE = "2025-04-01";
const DEFAULT_LIMIT = 200;

// ---------- Small utilities ----------
type Argv = {
    _: string[];
    [key: string]: string | boolean | string[];
};

function parseArgs(argv: string[]): Argv {
    const args: Argv = { _: [] };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i] as string;
        if (typeof a === "string" && a.startsWith("--")) {
            const [k, v] = a.includes("=")
                ? (a.slice(2).split("=") as [string, string])
                : [a.slice(2), argv[i + 1]?.startsWith("--") ? "true" : (argv[++i] as string)];
            (args as any)[k] = v === undefined ? true : v;
        } else {
            args._.push(a as string);
        }
    }
    return args;
}

function runGh(args: string[], options: { cwd?: string } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = execFile("gh", args, { windowsHide: true, ...options }, (err, stdout, stderr) => {
            if (err) {
                (err as any).stderr = stderr;
                return reject(err);
            }
            resolve(stdout.toString().trim());
        });
        if (child.stdout) child.stdout.setEncoding("utf8");
    });
}

// ---------- Core: fetch ----------
async function fetchCounts({
    repos,
    since,
    limit,
}: {
    repos: string[];
    users: string[];
    since: string;
    limit: number;
}): Promise<void> {
    const search = `merged:>${since}`;

    for (const repo of repos) {
        process.stdout.write(`Processing repo '${repo}'...\n`);
        try {
            const out = await runGh([
                "pr",
                "list",
                "--repo",
                repo,
                "--state",
                "merged",
                "--search",
                search,
                "--json",
                "additions,assignees,author,changedFiles,number,title,deletions,files,latestReviews,url",
                "-L",
                String(limit),
            ]);

            let data = JSON.parse(out) as PullRequest[];

            // Filter out Dependabot PRs
            data = data.filter((pr) => !isAuthorBot(pr.author));

            // If a PR has no assignee, add author as assignee
            data = data.filter((pr) => (pr.assignees.length === 0 ? pr.assignees.push(pr.author) && true : true));

            // Filter out reviews that are no approvals
            data.forEach((pr) => (pr.latestReviews = pr.latestReviews.filter((review) => review.state === "APPROVED")));

            const statsDir = path.resolve(process.cwd(), "stats");
            await fsp.mkdir(statsDir, { recursive: true });
            const filePath = path.join(statsDir, `pr-data-${repo.replaceAll("/", "_")}.json`);
            await fsp.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
        } catch (err: any) {
            process.stdout.write(`ERR\n`);
            if (err && err.stderr) {
                process.stdout.write(`gh error: ${String(err.stderr).split("\n")[0]}\n`);
            }
        }
    }
}

// ---------- Core: analyze ----------
type PRWithRepo = PullRequest & { __repo: string };

async function analyze(): Promise<void> {
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

    // person with most PRs (by author)
    const prCountByAuthor = new Map<string, number>();
    for (const pr of all) {
        const key = pr.author?.login ?? "unknown";
        prCountByAuthor.set(key, (prCountByAuthor.get(key) || 0) + 1);
    }
    const mostPRs = [...prCountByAuthor.entries()].sort((a, b) => b[1] - a[1])[0];

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

// ---------- CLI wiring ----------
function printHelp(): void {
    console.log(
        `Usage: pr-stats <command> [options]\n\nCommands:\n  fetch               Fetch counts via gh and persist to JSON (update only on changes)\n  analyze             Analyze previously fetched JSON data\n\nOptions (for fetch):\n  --since YYYY-MM-DD  Since date for merged PRs (default: ${DEFAULT_SINCE})\n  --limit N           Max PRs to consider per query (default: ${DEFAULT_LIMIT})\n  --repos CSV         Comma-separated list of repos\n  --users CSV         Comma-separated list of users\n`
    );
}

(async () => {
    const argv = parseArgs(process.argv);
    const cmd = argv._[0];

    if (!cmd || cmd === "help" || (argv as any).help || (argv as any).h) {
        printHelp();
        return;
    }

    if (cmd === "fetch") {
        const repos = ((argv.repos as string) ? String(argv.repos).split(",") : DEFAULT_REPOS)
            .map((s) => s.trim())
            .filter(Boolean);
        const users = ((argv.users as string) ? String(argv.users).split(",") : DEFAULT_USERS)
            .map((s) => s.trim())
            .filter(Boolean);
        const since = (argv.since as string) ? String(argv.since) : DEFAULT_SINCE;
        const limit = (argv.limit as string) ? Number(argv.limit) : DEFAULT_LIMIT;
        await fetchCounts({ repos, users, since, limit });
        return;
    }

    if (cmd === "analyze") {
        await analyze();
        return;
    }

    console.error(`Unknown command: ${cmd}`);
    printHelp();
    process.exitCode = 1;
})();
