/**
 * Builds the release artifact a VM runs, in the layout `hunt-ctl` and the systemd units expect below
 * `/srv/hunt/current`: `gateway/`, `relay/`, `session/` and `vm/`. Every Node entry point becomes one self-contained
 * ES module (`.mjs`) without third-party packages, so the VM needs nothing but Node.
 *
 *   node scripts/buildVmArtifact.ts <session|gateway>
 *
 * Writes `dist/apps/<app>/`. The gateway's artifact also holds the session's, which the gateway copies onto the
 * session VMs it creates; build the session first (`nx build gateway` does so through `dependsOn`).
 */
import { build, type Plugin } from "esbuild";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

interface Artifact {
  /** Output path without extension → entry module, relative to the repository root. */
  entries: Record<string, string>;
  /** Source → destination in the artifact, both relative; directories are copied whole. */
  files: [string, string][];
  /** Artifacts copied in first, by name. */
  includes: string[];
}

const ARTIFACTS: Record<string, Artifact> = {
  session: {
    entries: { "relay/main": "apps/session/src/relay/main.ts", "session/configCli": "apps/session/src/configCli.ts" },
    files: [
      ["libs/vm/hunt-ctl", "vm/hunt-ctl"],
      ["apps/session/vm/hunt-idle-check", "vm/hunt-idle-check"],
      ["apps/session/vm/agent.env", "vm/agent.env"],
      ["apps/session/vm/profile.sh", "vm/profile.sh"],
      ["apps/session/vm/systemd", "vm/systemd/session"],
      ["apps/session/acp-version", "session/acp-version"],
      ["apps/session/mcp-servers.json", "session/mcp-servers.json"],
      ["apps/session/playwright/package.json", "session/playwright/package.json"],
      ["apps/session/playwright/package-lock.json", "session/playwright/package-lock.json"],
    ],
    includes: [],
  },
  gateway: {
    entries: {
      "gateway/swf": "apps/gateway/src/swf.ts",
      "gateway/wake": "apps/gateway/src/wake.ts",
      "gateway/swfConfig": "apps/gateway/src/swfConfig.ts",
    },
    files: [
      ["libs/vm/hunt-ctl", "vm/hunt-ctl"],
      ["apps/gateway/vm/systemd", "vm/systemd/gateway"],
    ],
    includes: ["session"],
  },
};

/** Only Node's built-ins exist on the VM; any other package import fails the build instead of the service. */
const builtinsOnly: Plugin = {
  name: "builtins-only",
  setup(context) {
    context.onResolve({ filter: /^[^./]/ }, (args) =>
      isBuiltin(args.path) ? { path: args.path, external: true } : { errors: [{ text: `${args.path} is not a Node built-in; the VM has no node_modules` }] },
    );
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

function outputDir(name: string): string {
  return join(ROOT, "dist", "apps", name);
}

async function buildArtifact(name: string): Promise<void> {
  const artifact = ARTIFACTS[name];
  if (!artifact) throw new Error(`unknown artifact ${name}; expected one of ${Object.keys(ARTIFACTS).join(", ")}`);
  const out = outputDir(name);
  rmSync(out, { recursive: true, force: true });

  for (const included of artifact.includes) {
    const source = outputDir(included);
    if (!existsSync(source)) throw new Error(`the ${included} artifact is missing at ${source}; build it first`);
    cpSync(source, out, { recursive: true });
  }
  await build({
    entryPoints: Object.fromEntries(Object.entries(artifact.entries).map(([output, entry]) => [output, join(ROOT, entry)])),
    outdir: out,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    plugins: [builtinsOnly, rawText],
    logLevel: "warning",
  });
  for (const [source, destination] of artifact.files) {
    cpSync(join(ROOT, source), join(out, destination), { recursive: true });
  }
}

await buildArtifact(process.argv[2] ?? "");
