// Formats one file with the Prettier its project installs. Reads `{ "worktree", "filePath", "text" }` as JSON on stdin
// and prints `{ "installed": false }` when no Prettier resolves from the file, `{ "installed": true, "formatted": null }`
// when Prettier ignores the file (`.prettierignore`, `.gitignore`) or has no parser for it, the formatted text as
// `formatted` otherwise, or `{ "error": <first line of the message> }`. Runs with the worktree as cwd, where Prettier
// resolves the plugins of the config. Spawned by `format_with_prettier` in formatter.rs.
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const { worktree, filePath, text } = JSON.parse(Buffer.concat(chunks).toString("utf8"));

async function format() {
  let entry;
  try {
    entry = createRequire(filePath).resolve("prettier");
  } catch {
    return { installed: false };
  }
  const loaded = await import(pathToFileURL(entry).href);
  const prettier = loaded.default ?? loaded;
  const info = await prettier.getFileInfo(filePath, { ignorePath: [join(worktree, ".prettierignore"), join(worktree, ".gitignore")], resolveConfig: true });
  if (info.ignored || !info.inferredParser) return { installed: true, formatted: null };
  const config = (await prettier.resolveConfig(filePath, { editorconfig: true })) ?? {};
  return { installed: true, formatted: await prettier.format(text, { ...config, filepath: filePath }) };
}

try {
  process.stdout.write(JSON.stringify(await format()));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: String(error?.message ?? error).split("\n")[0] }));
}
