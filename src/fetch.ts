import { execFile } from "child_process";
import * as path from "path";
import { promises as fsp } from "fs";
import { authorToAssignee, isAuthorBot, PullRequest } from "./pr-data";

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

export async function fetchCounts({
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
                "additions,assignees,author,changedFiles,number,title,deletions,files,latestReviews,url,createdAt,mergedAt",
                "-L",
                String(limit),
            ]);

            let data = JSON.parse(out) as PullRequest[];

            // Filter out Dependabot/bot PRs
            data = data.filter((pr) => !isAuthorBot(pr.author));

            // If a PR has no assignee, add author as assignee
            data.forEach((pr) => {
                if (pr.assignees.length === 0) pr.assignees.push(authorToAssignee(pr.author));
            });

            // Keep only APPROVED reviews
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
