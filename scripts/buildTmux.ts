/**
 * Builds the tmux that the desktop app ships as sidecar (`bundle.externalBin` in `apps/client/src-tauri/tauri.conf.json`)
 * and runs the terminals of local sessions in. libevent, utf8proc and jemalloc are linked statically, so the binary needs
 * nothing but the libraries every macOS has under `/usr/lib`.
 *
 *   node scripts/buildTmux.ts
 *
 * Writes `apps/client/src-tauri/binaries/tmux-aarch64-apple-darwin` and the licenses of all four projects to
 * `apps/client/src-tauri/binaries/licenses/tmux.txt`, and does nothing when the binary there was built by this very
 * script (`.tmux-build` holds the script's hash). Needs macOS on Apple silicon with the Xcode command line tools.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUTPUT_DIR = join(ROOT, "apps/client/src-tauri/binaries");
const TARGET_TRIPLE = "aarch64-apple-darwin";
const OUTPUT_BINARY = join(OUTPUT_DIR, `tmux-${TARGET_TRIPLE}`);
const STAMP_FILE = join(OUTPUT_DIR, ".tmux-build");
/** The oldest macOS that runs on Apple silicon; the build fails on any newer API it would call unguarded. */
const DEPLOYMENT_TARGET = "11.0";

interface Source {
  name: string;
  url: string;
  sha256: string;
  /** Folder the archive unpacks into. */
  folder: string;
  /** License files inside that folder. */
  licenses: string[];
}

const LIBEVENT: Source = {
  name: "libevent 2.1.13",
  url: "https://github.com/libevent/libevent/releases/download/release-2.1.13-stable/libevent-2.1.13-stable.tar.gz",
  sha256: "f7e9383b8c0baa81b687e5b5eecc01beefaf1b19b64151d95ed61647fe7a315c",
  folder: "libevent-2.1.13-stable",
  licenses: ["LICENSE"],
};
const UTF8PROC: Source = {
  name: "utf8proc 2.12.0",
  url: "https://github.com/JuliaStrings/utf8proc/releases/download/v2.12.0/utf8proc-2.12.0.tar.gz",
  sha256: "a393fbef160835fb315bc3e91ba8d86f7a73a7cec9e6198b6c60b848b498bfeb",
  folder: "utf8proc-2.12.0",
  licenses: ["LICENSE.md"],
};
const JEMALLOC: Source = {
  name: "jemalloc 5.4.0",
  url: "https://github.com/jemalloc/jemalloc/releases/download/5.4.0/jemalloc-5.4.0.tar.bz2",
  sha256: "200776fac271093e7c2f21edd6d62657ecd2be578d9328633f2a86bfa6ef4f1d",
  folder: "jemalloc-5.4.0",
  licenses: ["COPYING"],
};
const TMUX: Source = {
  name: "tmux 3.8",
  url: "https://github.com/tmux/tmux/releases/download/3.8/tmux-3.8.tar.gz",
  sha256: "e79c699c7e949dccd0a4a125e17b8d1261e311b16979dbc8eb34542f3966d82e",
  folder: "tmux-3.8",
  licenses: ["COPYING"],
};
const SOURCES = [TMUX, LIBEVENT, UTF8PROC, JEMALLOC];

async function main(): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("buildTmux.ts builds on macOS on Apple silicon only");
  const recipe = createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");
  if (existsSync(OUTPUT_BINARY) && existsSync(STAMP_FILE) && readFileSync(STAMP_FILE, "utf8") === recipe) {
    console.log(`${OUTPUT_BINARY} is up to date`);
    return;
  }
  const workDir = mkdtempSync(join(tmpdir(), "hunt-tmux-"));
  try {
    const prefix = join(workDir, "prefix");
    for (const source of SOURCES) {
      await unpack(source, workDir);
    }
    buildLibevent(join(workDir, LIBEVENT.folder), prefix);
    buildUtf8proc(join(workDir, UTF8PROC.folder), prefix);
    buildJemalloc(join(workDir, JEMALLOC.folder), prefix);
    const binary = buildTmux(join(workDir, TMUX.folder), prefix);
    checkLinkage(binary);
    mkdirSync(join(OUTPUT_DIR, "licenses"), { recursive: true });
    copyFileSync(binary, OUTPUT_BINARY);
    chmodSync(OUTPUT_BINARY, 0o755);
    writeFileSync(join(OUTPUT_DIR, "licenses/tmux.txt"), licenseText(workDir));
    writeFileSync(STAMP_FILE, recipe);
    console.log(`built ${OUTPUT_BINARY}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** Downloads `source`, checks its hash and unpacks it into `workDir`. */
async function unpack(source: Source, workDir: string): Promise<void> {
  const response = await fetch(source.url);
  if (!response.ok) throw new Error(`failed to download ${source.name}: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const hash = createHash("sha256").update(archive).digest("hex");
  if (hash !== source.sha256) throw new Error(`failed to verify ${source.name}: SHA-256 ${hash}, expected ${source.sha256}`);
  const archivePath = join(workDir, source.url.split("/").pop() ?? source.folder);
  writeFileSync(archivePath, archive);
  run("tar", ["-xf", archivePath, "-C", workDir], workDir);
}

function buildLibevent(folder: string, prefix: string): void {
  // The SDK declares pipe2 for a newer macOS than the deployment target; configure would pick it up anyway.
  const options = ["--disable-shared", "--enable-static", "--disable-openssl", "--disable-samples", "--disable-libevent-regress"];
  run("./configure", [`--prefix=${prefix}`, ...options, "ac_cv_func_pipe2=no"], folder);
  run("make", [`-j${availableParallelism()}`], folder);
  run("make", ["install"], folder);
}

function buildUtf8proc(folder: string, prefix: string): void {
  run("make", [`-j${availableParallelism()}`, "libutf8proc.a"], folder);
  mkdirSync(join(prefix, "include"), { recursive: true });
  mkdirSync(join(prefix, "lib"), { recursive: true });
  copyFileSync(join(folder, "utf8proc.h"), join(prefix, "include/utf8proc.h"));
  copyFileSync(join(folder, "libutf8proc.a"), join(prefix, "lib/libutf8proc.a"));
}

function buildJemalloc(folder: string, prefix: string): void {
  run("./configure", [`--prefix=${prefix}`, "--disable-cxx", "--disable-doc"], folder);
  run("make", [`-j${availableParallelism()}`, "build_lib_static"], folder);
  run("make", ["install_lib_static", "install_include"], folder);
}

/** Builds tmux against the static libraries in `prefix` and returns the binary's path. */
function buildTmux(folder: string, prefix: string): string {
  const include = `-I${join(prefix, "include")}`;
  const library = (name: string) => join(prefix, "lib", name);
  run(
    "./configure",
    [
      "--enable-utf8proc",
      "--enable-jemalloc",
      "--disable-dependency-tracking",
      `CPPFLAGS=${include}`,
      `LIBEVENT_CORE_CFLAGS=${include}`,
      `LIBEVENT_CORE_LIBS=${library("libevent_core.a")}`,
      `LIBUTF8PROC_CFLAGS=${include}`,
      `LIBUTF8PROC_LIBS=${library("libutf8proc.a")}`,
      `JEMALLOC_CFLAGS=${include}`,
      // jemalloc replaces the default malloc zone from a constructor, which only a forced load keeps in the binary.
      `JEMALLOC_LIBS=-Wl,-force_load,${library("libjemalloc.a")}`,
    ],
    folder,
  );
  run("make", [`-j${availableParallelism()}`], folder);
  return join(folder, "tmux");
}

/** Fails unless `binary` links nothing but system libraries and runs as the pinned version. */
function checkLinkage(binary: string): void {
  const libraries = run("otool", ["-L", binary], ROOT).split("\n").slice(1).map((line) => line.trim()).filter(Boolean);
  const foreign = libraries.filter((library) => !library.startsWith("/usr/lib/"));
  if (foreign.length > 0) throw new Error(`tmux links libraries outside /usr/lib:\n${foreign.join("\n")}`);
  const version = run(binary, ["-V"], ROOT).trim();
  if (version !== TMUX.name) throw new Error(`tmux reports "${version}", expected "${TMUX.name}"`);
}

function licenseText(workDir: string): string {
  return SOURCES.map((source) => {
    const texts = source.licenses.map((license) => readFileSync(join(workDir, source.folder, license), "utf8").trim());
    return `${source.name}\n${"=".repeat(source.name.length)}\n\n${texts.join("\n\n")}\n`;
  }).join("\n\n");
}

/** Runs `program` in `cwd` with the build environment and returns its output; on failure prints all it wrote. */
function run(program: string, args: string[], cwd: string): string {
  const env = {
    ...process.env,
    MACOSX_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET,
    CFLAGS: "-O2 -Werror=unguarded-availability-new",
    // Homebrew's pkg-config would hand configure its shared libraries.
    PKG_CONFIG: "/usr/bin/false",
  };
  try {
    return execFileSync(program, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    console.error(failure.stdout ?? "", failure.stderr ?? "");
    throw new Error(`failed to run ${program} ${args.join(" ")} in ${cwd}`, { cause: error });
  }
}

await main();
