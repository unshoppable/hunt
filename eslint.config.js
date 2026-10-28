import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/** Lint rules the hand-formatted code must satisfy; formatting is not linted (there is no formatter). */
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "apps/client/src-tauri/**", "apps/client/src/ui/file-icons/atom-icons/**", "tools/**"] },
  ...tseslint.configs.recommended,
  ...reactHooks.configs.recommended,
  {
    files: ["apps/**/*.{ts,tsx}", "libs/**/*.ts", "scripts/**/*.ts"],
    rules: {
      // Guard clauses stay on one line; every other body is braced (see CLAUDE.md).
      curly: ["error", "multi-line"],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/no-explicit-any": "error",
      // A value object or domain model types its proxied attributes with `interface X extends z.infer<…> {}` merged into its class.
      "@typescript-eslint/no-empty-object-type": ["error", { allowInterfaces: "with-single-extends" }],
      "@typescript-eslint/no-unsafe-declaration-merging": "off",
      "prefer-const": ["error", { destructuring: "all" }],
      // The classic zod API adds ~700 KB to every VM bundle; `import * as z from "zod/mini"` tree-shakes to ~30 KB. The named
      // `{ z }` of zod/mini is a re-exported namespace object esbuild cannot shake either.
      "no-restricted-imports": ["error", { paths: [{ name: "zod", message: 'Write `import * as z from "zod/mini"`; the classic API adds ~700 KB to every VM bundle.' }] }],
      "no-restricted-syntax": [
        "error",
        { selector: 'ImportDeclaration[source.value="zod/mini"] ImportSpecifier', message: 'Write `import * as z from "zod/mini"`: the named `z` is a namespace object esbuild cannot tree-shake.' },
      ],
    },
  },
  {
    // Fixtures assert on values they just built; a non-null assertion is the shortest honest way to say so.
    files: ["apps/**/*.test.ts", "libs/**/*.test.ts", "scripts/**/*.test.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
