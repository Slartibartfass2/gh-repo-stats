import { fetchCounts } from "./fetch";
import { analyze } from "./analyze";

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
