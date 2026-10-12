import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/** Lint rules the hand-formatted code must satisfy; formatting is not linted (there is no formatter). */
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "src-tauri/**", "src/diff/atomIcons/**", "tools/**"] },
  ...tseslint.configs.recommended,
  ...reactHooks.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}", "scripts/**/*.ts", "remote/**/*.ts"],
    rules: {
      // Guard clauses stay on one line; every other body is braced (see CLAUDE.md).
      curly: ["error", "multi-line"],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/no-explicit-any": "error",
      "prefer-const": ["error", { destructuring: "all" }],
    },
  },
  {
    // Fixtures assert on values they just built; a non-null assertion is the shortest honest way to say so.
    files: ["src/**/*.test.ts", "scripts/**/*.test.ts", "remote/**/*.test.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
