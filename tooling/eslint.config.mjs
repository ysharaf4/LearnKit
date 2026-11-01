import tsparser from "@typescript-eslint/parser";
import path from "path";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

const rootDir = path.resolve(import.meta.dirname, "..");

export default defineConfig([
  {
    ignores: [
      "dist/**",
      "plugin/**",
      "node_modules/**",
      "scripts/**",
      "tooling/**",
      "src/**/*.js",
    ],
  },
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        activeDocument: "writable",
        activeWindow: "writable",
      },
    },
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: path.join(rootDir, "tsconfig.json"),
        tsconfigRootDir: rootDir,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
      "no-case-declarations": "warn",
      "@typescript-eslint/only-throw-error": "warn",
    },
  },
]);
