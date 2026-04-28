// @ts-check
const js = require("@eslint/js");
const tseslint = require("typescript-eslint");

// Legacy challenge-baseline files (initial commit, predate Task 0). Grandfathered until
// each is touched by Task 1+ work; new files added to src/** are linted normally.
// See interview/design_decisions.md §Task 0 — Legacy src/** grandfathering.
const legacySrcFiles = [
  "src/index.ts",
  "src/data-source.ts",
  "src/jobs/DataAnalysisJob.ts",
  "src/jobs/EmailNotificationJob.ts",
  "src/jobs/Job.ts",
  "src/jobs/JobFactory.ts",
  "src/routes/defaultRoute.ts",
  "src/workers/taskRunner.ts",
  "src/workers/taskWorker.ts",
];

module.exports = tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      "src/data/**",
      "public/**",
      ".husky/**",
      ...legacySrcFiles,
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // Type safety
      "@typescript-eslint/no-explicit-any": ["error", { ignoreRestArgs: true }],
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],

      // Async correctness
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false } },
      ],
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/return-await": ["error", "in-try-catch"],
      "@typescript-eslint/require-await": "off",

      // Complexity caps
      complexity: ["error", 10],
      "max-lines-per-function": [
        "error",
        { max: 80, skipBlankLines: true, skipComments: true },
      ],
      "max-lines": [
        "error",
        { max: 350, skipBlankLines: true, skipComments: true },
      ],
      "max-depth": ["error", 4],
      "max-params": ["error", 4],
      "max-nested-callbacks": ["error", 3],

      // Code style
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
      "no-throw-literal": "error",
    },
  },
  {
    files: ["tests/**", "**/*.test.ts", "**/*.spec.ts"],
    rules: {
      complexity: "off",
      "max-lines-per-function": "off",
      "max-lines": "off",
      "max-depth": "off",
      "max-params": "off",
      "max-nested-callbacks": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "no-console": "off",
    },
  },
  {
    files: ["*.config.ts", "*.config.mjs", "*.config.js", "vitest.config.ts"],
    rules: {
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "no-console": "off",
    },
  },
  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        module: "readonly",
        require: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        exports: "writable",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
    },
  }
);
