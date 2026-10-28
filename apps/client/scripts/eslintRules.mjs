// Lists the ESLint rules a worktree's flat configs set. Reads `{ "worktree", "configs" }` as JSON on stdin, `configs`
// being the worktree-relative paths of its `eslint.config.*` files, and prints `{ "configs": [...] }` with one entry
// per config: its path, whether ESLint resolves from it (`installed`), the first line of an `error` its import threw,
// and its `blocks`. A config that spreads another config shows only the blocks of its own, so configs are imported
// root first and a block the module cache already returned for an earlier config is skipped. A block lists the rules
// set to "warn" or "error", and "off" only where it switches off a rule an earlier block of the same config enabled;
// blocks without such a rule are left out. Every rule carries its documented description and URL and its origin: ESLint
// itself ("core"), a plugin installed from a registry ("package"), or a plugin that lives in the repository
// ("repository"). Prints `{ "error": <first line of the message> }` when the input cannot be read. Spawned by
// `read_lint_rules` in ide/lint_rules.rs.
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

// Configs may log while they are imported; stdout carries only the result.
console.log = console.error;
console.info = console.error;
console.warn = console.error;

const SEVERITIES = { 0: "off", 1: "warn", 2: "error", off: "off", warn: "warn", error: "error" };

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const { worktree, configs } = JSON.parse(Buffer.concat(chunks).toString("utf8"));

/** First line of a thrown value's message. */
function firstLine(error) {
  return String(error?.message ?? error).split("\n")[0];
}

/** The severity and options of a rule entry (`"error"`, `2`, `["error", { … }]`). */
function ruleSetting(entry) {
  const [level, ...options] = Array.isArray(entry) ? entry : [entry];
  return { severity: SEVERITIES[level] ?? "off", options };
}

/** The plugin namespace of a rule id (`@angular-eslint/template` for `@angular-eslint/template/no-negated-async`), `null` for a core rule. */
function namespaceOf(ruleId) {
  const slash = ruleId.lastIndexOf("/");
  return slash < 0 ? null : ruleId.slice(0, slash);
}

/** The package name ESLint's naming convention gives the plugin of `namespace`. */
function pluginPackage(namespace) {
  if (!namespace.startsWith("@")) return `eslint-plugin-${namespace}`;
  const [scope, name] = namespace.split("/");
  return name ? `${scope}/eslint-plugin-${name}` : `${scope}/eslint-plugin`;
}

/**
 * Whether the plugin of `namespace` is a package installed into a `node_modules` folder between `folder` and the
 * worktree, rather than code of the repository (imported by path, or linked into `node_modules` with `file:`).
 */
function isInstalledPackage(folder, namespace) {
  const name = pluginPackage(namespace);
  for (let current = folder; ; current = dirname(current)) {
    const candidate = join(current, "node_modules", name);
    if (existsSync(candidate)) return realpathSync(candidate).split(sep).includes("node_modules");
    if (current === worktree || dirname(current) === current) return false;
  }
}

async function readConfigs() {
  const ordered = [...configs].sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
  const loaded = [];
  for (const path of ordered) {
    const requireFromConfig = createRequire(join(worktree, path));
    let builtinRules;
    try {
      builtinRules = requireFromConfig("eslint/use-at-your-own-risk").builtinRules;
    } catch {
      loaded.push({ path, installed: false, error: null, blocks: [] });
      continue;
    }
    try {
      const exported = (await import(pathToFileURL(join(worktree, path)).href)).default;
      const blocks = (Array.isArray(exported) ? exported : [exported]).flat(Infinity).filter((block) => block && typeof block === "object");
      loaded.push({ path, installed: true, error: null, blocks, builtinRules });
    } catch (error) {
      loaded.push({ path, installed: true, error: firstLine(error), blocks: [] });
    }
  }

  // A config may set the rules of a plugin that only another config registers.
  const plugins = {};
  for (const config of loaded) {
    for (const block of config.blocks) {
      Object.assign(plugins, block.plugins ?? {});
    }
  }

  const seenBlocks = new WeakSet();
  return loaded.map(({ path, installed, error, blocks, builtinRules }) => {
    const folder = dirname(join(worktree, path));
    const enabled = new Set();
    const shownBlocks = [];
    for (const block of blocks) {
      const isInherited = seenBlocks.has(block);
      seenBlocks.add(block);
      const rules = [];
      for (const [id, entry] of Object.entries(block.rules ?? {})) {
        const { severity, options } = ruleSetting(entry);
        const wasEnabled = enabled.has(id);
        if (severity === "off") {
          enabled.delete(id);
        } else {
          enabled.add(id);
        }
        if (isInherited || (severity === "off" && !wasEnabled)) continue;
        const namespace = namespaceOf(id);
        const rule = namespace ? plugins[namespace]?.rules?.[id.slice(namespace.length + 1)] : builtinRules.get(id);
        const origin = !namespace ? "core" : isInstalledPackage(folder, namespace) ? "package" : "repository";
        rules.push({ id, severity, options, description: rule?.meta?.docs?.description ?? null, url: rule?.meta?.docs?.url ?? null, origin });
      }
      if (rules.length === 0) continue;
      shownBlocks.push({ files: (block.files ?? []).flat().map(String), ignores: (block.ignores ?? []).map(String), rules });
    }
    return { path, installed, error, blocks: shownBlocks };
  });
}

try {
  process.stdout.write(JSON.stringify({ configs: await readConfigs() }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: firstLine(error) }));
}
