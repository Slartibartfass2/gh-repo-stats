import { fetchCounts } from "./fetch";
import { analyze } from "./analyze";
import { loadOptions } from "./config";

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

function printHelp(): void {
    console.log(
        `Usage: pr-stats <command>\n\nCommands:\n  fetch               Fetch PR data via gh and write JSON per repo in stats/\n  analyze             Analyze previously fetched JSON data\n\nConfiguration:\n  Set environment variables (REPOS, USERS, SINCE, LIMIT). A .env file is supported.\n`
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
        try {
            const opts = loadOptions();
            await fetchCounts(opts);
        } catch (e: any) {
            console.error(e.message || String(e));
            process.exitCode = 1;
        }
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
