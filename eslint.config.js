// Strict lint configuration. The core (src/) is held to every recommended
// rule set plus a long list of extra correctness rules; tests get a few
// relaxations for readability. Formatting is Prettier's job.

import js from "@eslint/js";
import globals from "globals";
import n from "eslint-plugin-n";
import promise from "eslint-plugin-promise";
import security from "eslint-plugin-security";
import sonarjs from "eslint-plugin-sonarjs";
import unicorn from "eslint-plugin-unicorn";

const strictCore = {
  // Correctness
  "array-callback-return": "error",
  "consistent-return": "error",
  "default-case-last": "error",
  "eqeqeq": ["error", "always"],
  "no-await-in-loop": "off", // sequential HTTP walks and polling are intentional
  "no-constant-binary-expression": "error",
  "no-constructor-return": "error",
  "no-duplicate-imports": "error",
  "no-else-return": ["error", { allowElseIf: false }],
  "no-eval": "error",
  "no-extend-native": "error",
  "no-implicit-coercion": "error",
  "no-implied-eval": "error",
  "no-lonely-if": "error",
  "no-loop-func": "error",
  "no-new-func": "error",
  "no-new-wrappers": "error",
  "no-param-reassign": ["error", { props: false }],
  "no-promise-executor-return": "error",
  "no-return-assign": "error",
  "no-self-compare": "error",
  "no-sequences": "error",
  "no-shadow": "error",
  "no-template-curly-in-string": "error",
  "no-throw-literal": "error",
  "no-undef-init": "error",
  "no-unmodified-loop-condition": "error",
  "no-unneeded-ternary": "error",
  "no-unreachable-loop": "error",
  "no-unused-expressions": "error",
  "no-unused-private-class-members": "error",
  "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
  "no-use-before-define": ["error", { functions: false, classes: true, variables: false }],
  "no-useless-call": "error",
  "no-useless-computed-key": "error",
  "no-useless-concat": "error",
  "no-useless-rename": "error",
  "no-useless-return": "error",
  "no-var": "error",
  "no-void": "error",
  "object-shorthand": "error",
  "prefer-arrow-callback": "error",
  "prefer-const": "error",
  "prefer-destructuring": ["error", { object: true, array: false }],
  "prefer-exponentiation-operator": "error",
  "prefer-numeric-literals": "error",
  "prefer-object-spread": "error",
  "prefer-promise-reject-errors": "error",
  "prefer-regex-literals": "error",
  "prefer-rest-params": "error",
  "prefer-spread": "error",
  "prefer-template": "error",
  "radix": "error",
  "require-atomic-updates": "off", // false positives on sequential awaits in this codebase
  "require-await": "error",
  "require-unicode-regexp": "error",
  "strict": ["error", "never"],
  "symbol-description": "error",
  "yoda": "error",
  // Complexity budgets: keep the core readable.
  "complexity": ["error", 20],
  "max-depth": ["error", 4],
  "max-nested-callbacks": ["error", 4],
  "max-params": ["error", 4],
  // Plugin adjustments
  "n/no-process-exit": "off", // bin entry exits deliberately after reporting
  "n/no-unsupported-features/node-builtins": [
    "error",
    {
      version: ">=20.17.0",
      ignores: ["fetch", "Response", "Headers", "test", "test.describe", "test.it", "test.before", "test.after"],
    },
  ],
  "n/hashbang": "off", // bin/zclaude.js is declared in package.json bin
  "unicorn/prevent-abbreviations": "off",
  "unicorn/name-replacements": "off", // env, args, dir are idiomatic in a CLI
  "unicorn/consistent-boolean-name": "off",
  "unicorn/single-line-block-comment-style": "off",
  "unicorn/no-declarations-before-early-exit": "off",
  "unicorn/prefer-await": "off", // promise wrappers around callbacks and event races are deliberate
  "sonarjs/publicly-writable-directories": "off", // mkdtemp under os.tmpdir() is the safe pattern
  "unicorn/no-null": "off",
  "unicorn/no-process-exit": "off",
  "unicorn/filename-case": ["error", { case: "kebabCase" }],
  "unicorn/no-array-for-each": "off",
  "unicorn/no-array-reduce": "off",
  "unicorn/switch-case-braces": "off",
  "unicorn/prefer-top-level-await": "off",
  "unicorn/catch-error-name": ["error", { name: "error" }],
  "unicorn/no-useless-undefined": ["error", { checkArguments: false }],
  "unicorn/prefer-string-raw": "off",
  "unicorn/no-nested-ternary": "off",
  "unicorn/prefer-global-this": "off",
  "unicorn/import-style": "off",
  "unicorn/prefer-ternary": "off",
  "unicorn/no-await-expression-member": "off",
  "unicorn/prefer-event-target": "off",
  "unicorn/no-negated-condition": "off",
  "unicorn/consistent-function-scoping": "off",
  "unicorn/prefer-module": "off",
  "unicorn/no-array-callback-reference": "off",
  "unicorn/error-message": "error",
  "unicorn/no-unused-properties": "error",
  "unicorn/prefer-node-protocol": "error",
  "sonarjs/cognitive-complexity": ["error", 25],
  "sonarjs/no-duplicate-string": "off",
  "sonarjs/no-nested-conditional": "off",
  "sonarjs/no-nested-template-literals": "off",
  "sonarjs/no-os-command-from-path": "off", // security/child-process covers it; `security` is resolved by PATH by design
  "sonarjs/os-command": "off",
  "sonarjs/no-clear-text-protocols": "off", // the zcode:// scheme and http:// test URLs are not network protocols
  "sonarjs/pseudo-random": "off",
  "sonarjs/todo-tag": "error",
  "sonarjs/fixme-tag": "error",
  "sonarjs/no-selector-parameter": "off",
  "security/detect-object-injection": "off", // every keyed access here is on our own literals
  "security/detect-non-literal-fs-filename": "off", // config paths are computed by design
  "security/detect-non-literal-regexp": "off",
  "security/detect-child-process": "off", // spawning claude, security and osascript is the job
  "security/detect-unsafe-regex": "error",
  "promise/always-return": "off",
  "promise/no-callback-in-promise": "off",
  "promise/no-nesting": "off",
};

export default [
  {
    ignores: ["node_modules/**", "coverage/**", "*.tgz"],
  },
  js.configs.recommended,
  n.configs["flat/recommended-module"],
  unicorn.configs.recommended,
  promise.configs["flat/recommended"],
  security.configs.recommended,
  sonarjs.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2024,
        fetch: "readonly",
        Response: "readonly",
        Headers: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        DOMException: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
      },
    },
    rules: strictCore,
  },
  {
    files: ["site/**/*.js"],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      "n/no-unsupported-features/node-builtins": "off",
      "n/no-unsupported-features/es-builtins": "off",
      "n/no-unsupported-features/es-syntax": "off",
      "unicorn/prefer-query-selector": "off",
    },
  },
  {
    files: ["test/**/*.js"],
    rules: {
      "max-nested-callbacks": ["error", 6],
      "require-await": "off", // async mocks mirror the real signatures
      "no-template-curly-in-string": "off", // shell snippets in fixtures
      "no-shadow": "off",
      "sonarjs/no-hardcoded-passwords": "off",
      "sonarjs/no-hardcoded-secrets": "off",
      "sonarjs/assertions-in-tests": "off",
      "unicorn/no-unused-properties": "off",
      "unicorn/consistent-destructuring": "off",
      "n/no-unpublished-import": "off",
      "sonarjs/no-empty-test-file": "off",
    },
  },
  {
    files: ["eslint.config.js"],
    rules: { "n/no-unpublished-import": "off", "unicorn/filename-case": "off" },
  },
];
