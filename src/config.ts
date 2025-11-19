import dotenv from "dotenv";

dotenv.config();

function csvToArray(val: string | undefined): string[] {
    if (!val) return [];
    return val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

export interface Options {
    repos: string[];
    from: string;
    until: string;
    limit: number;
}

export function loadOptions(): Options {
    const repos = csvToArray(process.env.REPOS);
    const from = process.env.FROM;
    let until = process.env.UNTIL;
    const limitEnv = process.env.LIMIT;

    const errors: string[] = [];
    if (!repos.length) errors.push("REPOS must be set (comma-separated list)");
    if (!from) errors.push("FROM must be set (YYYY-MM-DD)");
    if (!until) until = new Date().toISOString().slice(0, 10);
    const limit = Number(limitEnv);
    if (!limitEnv || !Number.isFinite(limit) || limit <= 0) errors.push("LIMIT must be a positive integer");

    if (errors.length) {
        const help = "Missing or invalid configuration. Set required env vars. See .env.example for details.";
        throw new Error(`${help}\n- ${errors.join("\n- ")}`);
    }

    return {
        repos,
        from: from!,
        until: until,
        limit,
    };
}
