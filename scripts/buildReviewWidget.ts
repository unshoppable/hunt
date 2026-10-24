/**
 * Bundles the review widget (`apps/session/src/review/widget.ts`) into one minified browser script. The VM artifact
 * ships it as `session/review.js` (`buildVmArtifact.ts`); the desktop app compiles it in and injects it into every page
 * of a local session's Chrome (`nx run client:review-widget` writes `apps/client/src-tauri/resources/review.js`).
 *
 *   node scripts/buildReviewWidget.ts <output file>
 */
import { build, type Plugin } from "esbuild";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WIDGET_ENTRY = "apps/session/src/review/widget.ts";

/** A browser script imports nothing but modules of the repository. */
const relativeOnly: Plugin = {
  name: "relative-only",
  setup(context) {
    context.onResolve({ filter: /^[^./]/ }, (args) => ({ errors: [{ text: `${args.path} is no module of the repository; a browser script bundles no packages` }] }));
  },
};

/** Writes the widget's bundle to `outputFile`, an absolute path or one relative to the working directory. */
export async function buildReviewWidget(outputFile: string): Promise<void> {
  await build({
    entryPoints: [join(ROOT, WIDGET_ENTRY)],
    outfile: resolve(outputFile),
    bundle: true,
    minify: true,
    platform: "browser",
    format: "iife",
    target: "es2020",
    plugins: [relativeOnly],
    logLevel: "warning",
  });
}

if (import.meta.main) {
  const outputFile = process.argv[2];
  if (!outputFile) throw new Error("usage: node scripts/buildReviewWidget.ts <output file>");
  await buildReviewWidget(outputFile);
}
