/**
 * Cuts the next release version. Reads the Conventional Commits since the last `v*` tag, derives the release type
 * (or takes it from `--bump`), rewrites the version in every file that carries it and writes `version` and `notes`
 * to `$GITHUB_OUTPUT` when running in Actions. Committing, tagging and pushing stay in `release.yml`.
 *
 *   node scripts/release/release.ts [--bump auto|patch|minor|major] [--dry-run]
 *
 * Runs on plain Node ≥ 22.18 (type stripping); no dependencies. Exits 1 with a message when nothing is releasable or a
 * version file does not hold the expected current version.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bumpFor, nextVersion, parseCommit, renderNotes, type Bump, type ConventionalCommit, type RawCommit } from "./conventionalCommits.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BUMPS = new Set<string>(["auto", "patch", "minor", "major"]);

interface VersionFile {
  path: string;
  /** Matches the version to replace; group 1 and 2 are the text to keep around it. */
  pattern: (current: string) => RegExp;
  occurrences: number;
}

/** Every place the version is written; counts guard against a file that drifted out of sync. */
const VERSION_FILES: VersionFile[] = [
  { path: "package.json", pattern: (current) => new RegExp(`("version": ")${escape(current)}(")`, "g"), occurrences: 1 },
  { path: "package-lock.json", pattern: (current) => new RegExp(`("name": "hunt",\\s*"version": ")${escape(current)}(")`, "g"), occurrences: 2 },
  { path: "apps/client/package.json", pattern: (current) => new RegExp(`("version": ")${escape(current)}(")`, "g"), occurrences: 1 },
  { path: "apps/client/src-tauri/Cargo.toml", pattern: (current) => new RegExp(`(^version = ")${escape(current)}(")`, "gm"), occurrences: 1 },
  { path: "apps/client/src-tauri/Cargo.lock", pattern: (current) => new RegExp(`(name = "hunt"\\nversion = ")${escape(current)}(")`, "g"), occurrences: 1 },
];

interface Options {
  bump: "auto" | Bump;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { bump: "auto", dryRun: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--bump") {
      const value = argv[++index];
      if (!value || !BUMPS.has(value)) throw new Error(`failed to parse --bump: expected auto|patch|minor|major, got "${value ?? ""}"`);
      options.bump = value as Options["bump"];
    } else {
      throw new Error(`failed to parse arguments: unknown option "${arg}"`);
    }
  }
  return options;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function lastTag(): string | undefined {
  try {
    return git("describe", "--tags", "--match", "v*", "--abbrev=0");
  } catch {
    return undefined;
  }
}

/** Commits in `range`, oldest first; records are separated by RS (0x1e), fields by US (0x1f). */
function commitsIn(range: string): RawCommit[] {
  const log = git("log", "--reverse", "--format=%H%x1f%s%x1f%b%x1e", range);
  return log
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, subject = "", body = ""] = record.split("\x1f");
      return { hash, subject, body };
    });
}

function currentVersion(): string {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { version?: string };
  if (!manifest.version) throw new Error("failed to read version: package.json has no version field");
  return manifest.version;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Rewrites the version in one file, refusing when the current version is not found exactly as often as expected. */
function rewriteVersion(file: VersionFile, current: string, next: string, dryRun: boolean): void {
  const path = resolve(ROOT, file.path);
  const content = readFileSync(path, "utf8");
  const pattern = file.pattern(current);
  const found = [...content.matchAll(pattern)].length;
  if (found !== file.occurrences) {
    throw new Error(`failed to bump ${file.path}: expected ${file.occurrences} occurrence(s) of version ${current}, found ${found}`);
  }
  if (dryRun) return;
  writeFileSync(path, content.replace(pattern, `$1${next}$2`));
}

function writeOutputs(version: string, notes: string): void {
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    appendFileSync(output, `version=${version}\nnotes<<HUNT_RELEASE_NOTES\n${notes}\nHUNT_RELEASE_NOTES\n`);
  }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    appendFileSync(summary, `## Hunt v${version}\n\n${notes || "_No conventional commits to list._"}\n`);
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const current = currentVersion();
  const tag = lastTag();
  if (tag && tag !== `v${current}`) {
    console.warn(`warning: package.json is at ${current} but the last tag is ${tag}; bumping from ${current}`);
  }
  const commits: ConventionalCommit[] = commitsIn(tag ? `${tag}..HEAD` : "HEAD")
    .map(parseCommit)
    .filter((commit): commit is ConventionalCommit => Boolean(commit));
  const bump = options.bump === "auto" ? bumpFor(commits) : options.bump;
  if (!bump) {
    throw new Error(`failed to compute version: no releasable commits since ${tag ?? "the first commit"} (feat, fix, perf, revert or a breaking change)`);
  }
  const next = nextVersion(current, bump);
  const notes = renderNotes(commits);

  for (const file of VERSION_FILES) {
    rewriteVersion(file, current, next, options.dryRun);
  }
  if (!options.dryRun) {
    writeOutputs(next, notes);
  }

  const verb = options.dryRun ? "would bump" : "bumped";
  console.log(`${verb} ${current} → ${next} (${bump}, ${commits.length} conventional commit(s) since ${tag ?? "the first commit"})`);
  console.log(VERSION_FILES.map((file) => `  ${file.path}`).join("\n"));
  if (notes) {
    console.log(`\n${notes}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
