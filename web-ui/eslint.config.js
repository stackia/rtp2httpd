import { fileURLToPath } from "node:url";
import love from "eslint-config-love";

const baseLanguageOptions = love.languageOptions ?? {};
const baseParserOptions = baseLanguageOptions.parserOptions ?? {};
const baseGlobals = baseLanguageOptions.globals ?? {};
const tsconfigRootDir = fileURLToPath(new URL("./", import.meta.url));

export default [
  {
    ...love,
    files: ["**/*.{ts,tsx,js,jsx}"],
    ignores: ["dist/**", "node_modules/**", "eslint.config.js"],
    languageOptions: {
      ...baseLanguageOptions,
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...baseGlobals,
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        localStorage: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
      },
      parserOptions: {
        ...baseParserOptions,
        project: "./tsconfig.json",
        tsconfigRootDir,
        ecmaFeatures: {
          ...(baseParserOptions.ecmaFeatures ?? {}),
          jsx: true,
        },
      },
    },
    rules: {
      ...love.rules,
      "@typescript-eslint/no-magic-numbers": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/strict-boolean-expressions": "off",
      "@typescript-eslint/no-unsafe-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/prefer-destructuring": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/non-nullable-type-assertion-style": "off",
      "@typescript-eslint/no-deprecated": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "no-console": "off",
      "no-alert": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/promise-function-async": "off",
      "max-lines": "off",
      complexity: "off",
    },
  },
];
