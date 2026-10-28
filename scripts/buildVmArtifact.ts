/**
 * Builds the release artifact a VM runs, in the layout `hunt-ctl` and the systemd units expect below
 * `/srv/hunt/current`: `gateway/`, `relay/`, `session/` and `vm/`. Every Node entry point becomes one self-contained
 * ES module (`.mjs`) with the few packages it may use bundled in (BUNDLED_PACKAGES), so the VM needs nothing but Node;
 * the review widget, which the review server hands to web pages, one minified script (`.js`, see `buildReviewWidget.ts`).
 *
 *   node scripts/buildVmArtifact.ts <session|gateway>
 *
 * Writes `dist/apps/<app>/` with `.version` (the environment's APP_VERSION, which the CI deploy sets, else `dev`),
 * `protocol.json`, the protocols that `libs/domain/protocol.json` numbers and the desktop app checks, and `.hash`, the
 * first 16 hex digits of a SHA-256 over every other file's path and content: `hunt-ctl install` and `stage-session`
 * file a release under it, and the gateway compares it with a session VM's installed release.
 */
import { build, type Plugin } from "esbuild";
import { createHash } from "node:crypto";
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReviewWidget } from "./buildReviewWidget.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

interface Artifact {
  /** Output path without extension → entry module, relative to the repository root. */
  entries: Record<string, string>;
  /** Path of the review widget's bundle in the artifact. */
  reviewWidget?: string;
  /** Source → destination in the artifact, both relative; directories are copied whole. */
  files: [string, string][];
}

const ARTIFACTS: Record<string, Artifact> = {
  session: {
    entries: {
      "relay/main": "apps/session/src/relay/relay.main.ts",
      "session/configCli": "apps/session/src/session-config/session-config.main.ts",
      "session/syncHelper": "apps/session/src/sync/sync-helper.main.ts",
      "session/transcriptHelper": "apps/session/src/sync/transcript-helper.main.ts",
      "session/statusHelper": "apps/session/src/relay/status-helper.main.ts",
      "session/reviewServer": "apps/session/src/review/review-server.main.ts",
    },
    reviewWidget: "session/review.js",
    files: [
      ["libs/vm/hunt-ctl", "vm/hunt-ctl"],
      ["apps/session/vm/hunt-idle-check", "vm/hunt-idle-check"],
      ["apps/session/vm/hunt-service", "vm/hunt-service"],
      ["apps/session/vm/hunt-gh", "vm/hunt-gh"],
      ["apps/session/vm/sudoers-hunt-service", "vm/sudoers-hunt-service"],
      ["apps/session/vm/agent.env", "vm/agent.env"],
      ["apps/session/vm/profile.sh", "vm/profile.sh"],
      ["apps/session/vm/tmux.conf", "vm/tmux.conf"],
      ["apps/session/vm/systemd", "vm/systemd/session"],
      ["apps/session/vm/desktop", "vm/desktop"],
      ["apps/session/acp-version", "session/acp-version"],
      ["apps/session/mcp-servers.json", "session/mcp-servers.json"],
      ["apps/session/playwright/package.json", "session/playwright/package.json"],
      ["apps/session/playwright/package-lock.json", "session/playwright/package-lock.json"],
    ],
  },
  gateway: {
    entries: {
      "gateway/swf": "apps/gateway/src/swf/swf.main.ts",
      "gateway/wake": "apps/gateway/src/wake/wake.main.ts",
      "gateway/api": "apps/gateway/src/gateway-api/gateway-api.main.ts",
      "gateway/apiClient": "apps/gateway/src/gateway-api/gateway-api-forwarder.main.ts",
    },
    files: [
      ["libs/vm/hunt-ctl", "vm/hunt-ctl"],
      ["apps/gateway/vm/hunt-api", "vm/hunt-api"],
      ["apps/gateway/vm/sshd-hunt-api.conf", "vm/sshd-hunt-api.conf"],
      ["apps/gateway/vm/sudoers-hunt-api", "vm/sudoers-hunt-api"],
      ["apps/gateway/vm/systemd", "vm/systemd/gateway"],
    ],
  },
};

/** The packages an entry point may import besides Node's built-ins; esbuild bundles them into the `.mjs`. */
const BUNDLED_PACKAGES = new Set(["zod"]);

/**
 * Only Node's built-ins exist on the VM: they stay external, the packages of BUNDLED_PACKAGES are bundled, and any
 * other package import fails the build instead of the service.
 */
const allowedPackages: Plugin = {
  name: "allowed-packages",
  setup(context) {
    context.onResolve({ filter: /^[^./]/ }, (args) => {
      if (isBuiltin(args.path)) return { path: args.path, external: true };
      if (BUNDLED_PACKAGES.has(args.path.split("/")[0])) return undefined;
      return { errors: [{ text: `${args.path} is neither a Node built-in nor one of the bundled packages (${[...BUNDLED_PACKAGES].join(", ")}); the VM has no node_modules` }] };
    });
  },
};

/** Inlines `import text from "./file.md?raw"` as a string, like Vite does for the tests. */
const rawText: Plugin = {
  name: "raw-text",
  setup(context) {
    context.onResolve({ filter: /\?raw$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.slice(0, -"?raw".length)), namespace: "raw" }));
    context.onLoad({ filter: /.*/, namespace: "raw" }, (args) => ({ contents: readFileSync(args.path, "utf8"), loader: "text" }));
  },
};

/** The files below `dir` as paths relative to it, sorted. */
function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();
}

/** The release's hash: see the module comment. */
function contentHash(dir: string): string {
  const hash = createHash("sha256");
  for (const path of listFiles(dir).filter((path) => path !== ".hash")) {
    hash.update(`${path}\0`).update(readFileSync(join(dir, path))).update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

function outputDir(name: string): string {
  return join(ROOT, "dist", "apps", name);
}

async function buildArtifact(name: string): Promise<void> {
  const artifact = ARTIFACTS[name];
  if (!artifact) throw new Error(`unknown artifact ${name}; expected one of ${Object.keys(ARTIFACTS).join(", ")}`);
  const out = outputDir(name);
  rmSync(out, { recursive: true, force: true });
  await build({
    entryPoints: Object.fromEntries(Object.entries(artifact.entries).map(([output, entry]) => [output, join(ROOT, entry)])),
    outdir: out,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    plugins: [allowedPackages, rawText],
    logLevel: "warning",
  });
  if (artifact.reviewWidget) {
    await buildReviewWidget(join(out, artifact.reviewWidget));
  }
  for (const [source, destination] of [...artifact.files, ["libs/domain/protocol.json", "protocol.json"]]) {
    cpSync(join(ROOT, source), join(out, destination), { recursive: true });
  }
  writeFileSync(join(out, ".version"), `${process.env.APP_VERSION || "dev"}\n`);
  writeFileSync(join(out, ".hash"), `${contentHash(out)}\n`);
}

await buildArtifact(process.argv[2] ?? "");
