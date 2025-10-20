import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";
import unusedImports from "eslint-plugin-unused-imports";
import prettierPlugin from "eslint-plugin-prettier";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
    { ignores: ["dist/**", "node_modules/**", "stats/**", "**/*.d.ts", "eslint.config.*"] },
    ...tseslint.configs.recommendedTypeChecked,
    {
        languageOptions: {
            ecmaVersion: 2021,
            sourceType: "module",
            parserOptions: {
                project: ["./tsconfig.json"],
                tsconfigRootDir: __dirname,
            },
        },
        plugins: {
            import: importPlugin,
            "unused-imports": unusedImports,
            prettier: prettierPlugin,
        },
        settings: {
            "import/resolver": {
                typescript: {
                    project: "./tsconfig.json",
                },
            },
        },
        rules: {
            // General
            "prefer-const": "warn",

            // Imports
            "import/no-default-export": "error",
            "import/no-unresolved": "off",

            // Unused imports/vars
            "unused-imports/no-unused-imports": "warn",
            "unused-imports/no-unused-vars": [
                "warn",
                { vars: "all", varsIgnorePattern: "^_", args: "after-used", argsIgnorePattern: "^_" },
            ],

            // TypeScript safety rules (relaxed to warn for initial adoption)
            "@typescript-eslint/require-await": "off",
            "@typescript-eslint/no-floating-promises": "warn",
            "@typescript-eslint/no-misused-promises": ["warn", { checksVoidReturn: false }],
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unsafe-member-access": "off",
            "@typescript-eslint/no-unsafe-assignment": "off",
            "@typescript-eslint/no-unsafe-return": "off",
            "@typescript-eslint/no-unsafe-call": "off",
            "@typescript-eslint/no-unsafe-argument": "off",
            "@typescript-eslint/no-unnecessary-type-assertion": "warn",
            "prefer-promise-reject-errors": "warn",

            // Prettier formatting
            "prettier/prettier": "warn",
        },
    },
    {
        files: ["**/*.js", "**/*.cjs", "eslint.config.*"],
        languageOptions: {
            // Use default JS parser (espree) for JS config files
            parser: undefined,
            parserOptions: {},
        },
        rules: {
            // Allow default exports in config files
            "import/no-default-export": "off",
        },
    }
);
