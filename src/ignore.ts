import * as fs from "fs";
import * as path from "path";

export type RepoIgnoreRule = {
    // Ignore files whose repo-relative path starts with one of these prefixes
    pathPrefixes?: string[];
    // Ignore files whose path ends with one of these extensions (with or without leading dot)
    extensions?: string[];
};

export type IgnoreRules = {
    // Key is repo full name e.g., "owner/repo"; optional "*" applies to all repos
    [repo: string]: RepoIgnoreRule;
};

export function loadIgnoreRules(): IgnoreRules {
    const envPath = process.env.IGNORE_CONFIG;
    const defaultPath = path.resolve(process.cwd(), "ignore.rules.json");
    const filePath = envPath && envPath.trim().length > 0 ? envPath : fs.existsSync(defaultPath) ? defaultPath : "";
    if (!filePath) return {};
    try {
        const raw = fs.readFileSync(filePath, "utf8");
        const obj = JSON.parse(raw) as IgnoreRules;
        return obj || {};
    } catch (e) {
        console.warn(`Failed to load ignore rules from ${filePath}: ${(e as any)?.message || e}`);
        return {};
    }
}

function normExt(ext: string): string {
    ext = ext.trim();
    if (!ext) return "";
    return ext.startsWith(".") ? ext.toLowerCase() : "." + ext.toLowerCase();
}

export function shouldIgnoreFile(repo: string, filePath: string, rules: IgnoreRules): boolean {
    const rule = rules[repo] || rules["*"];
    if (!rule) return false;
    const p = filePath.replace(/\\/g, "/");
    if (rule.pathPrefixes && rule.pathPrefixes.some((pref) => p.startsWith(pref.replace(/\\/g, "/")))) {
        return true;
    }
    if (rule.extensions && rule.extensions.length > 0) {
        const lower = p.toLowerCase();
        for (const e of rule.extensions) {
            const ne = normExt(e);
            if (!ne) continue;
            if (lower.endsWith(ne)) return true;
        }
    }
    return false;
}
