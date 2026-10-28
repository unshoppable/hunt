#!/usr/bin/env node
/**
 * Vendors the Atom Material Icons (github.com/mallowigi/iconGenerator for the SVGs, github.com/AtomMaterialUI/a-file-icon-vscode
 * for the file and folder associations) into src/ui/file-icons/atom-icons, with every color turned pastel.
 *
 * Usage: node tools/icons/syncAtomIcons.mjs <iconGenerator-clone> <a-file-icon-vscode-clone> [pastel]
 *   pastel  0..1, default 0.6; 0 keeps the upstream Material colors
 *
 * Pastel: each hex color in a fill, stroke, stop-color or color (attribute or style declaration) is converted to OKLCH;
 * lightness is lifted towards white by `pastel / 2` of the remaining distance (so light glyphs stay lighter than the
 * folder body behind them), chroma is scaled down by `0.4 * pastel` and then reduced until the color fits into sRGB.
 * Hue is kept. Named colors (white, black in masks) stay as they are.
 *
 * Names: file icons keep their upstream name, lowercased ("typescript", "nestservice"). Folder icons become
 * `folder_<name>` and `folder_<name>_open`. The fallbacks are `_file`, `_folder`, `_folder_open`, `_root`, `_root_open`.
 * Associations gated behind an icon pack (`enabledFor`, e.g. Angular or NestJS file kinds) are left out; the file icon
 * rules in src/settings/settings.store.ts assign those by path. Icons with a light variant use their `_dark` SVG, as upstream
 * does for dark themes.
 *
 * Hunt-specific icons (Atom style, saturated Material colors) live in tools/icons/custom/icons and are made pastel the
 * same way; an upstream icon of the same name wins. An optional tools/icons/custom/associations.json
 * ({ fileNames?, fileExtensions?, folderNames? }) is merged on top of the upstream associations.
 *
 * Output (fully regenerated on every run):
 *   icons/*.svg        every upstream file and folder icon plus the custom ones, pastel
 *   associations.json  { source, fileNames, fileExtensions, folderNames } (lowercase keys, values are icon basenames)
 *   LICENSE            upstream license
 * A preview page inlining every icon is written to the OS temp directory; its path is printed.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SVG_REPOSITORY = "https://github.com/mallowigi/iconGenerator.git";
const ASSOCIATION_REPOSITORY = "https://github.com/AtomMaterialUI/a-file-icon-vscode.git";
/** Upstream icons Hunt's fallbacks are built from: [Hunt name, upstream folder, upstream name]. */
const FALLBACKS = [
  ["_file", "files", "file"],
  ["_folder", "folders", "folder"],
  ["_folder_open", "foldersOpen", "folder"],
  ["_root", "folders", "folder-root"],
  ["_root_open", "foldersOpen", "folder-root"],
];
/** Lightness above which a color is already pastel enough to keep its chroma. */
const LIGHT_ENOUGH = 0.92;

const [, , svgClonePath, associationClonePath, pastelArg = "0.6"] = process.argv;
if (!svgClonePath || !associationClonePath) throw new Error("usage: syncAtomIcons.mjs <iconGenerator-clone> <a-file-icon-vscode-clone> [pastel]");
const PASTEL = Number(pastelArg);
if (!(PASTEL >= 0 && PASTEL <= 1)) throw new Error(`pastel must be between 0 and 1, got ${pastelArg}`);
const SVG_CLONE = resolve(svgClonePath);
const ASSOCIATION_CLONE = resolve(associationClonePath);
const ASSETS = join(SVG_CLONE, "assets/icons");
const TOOLS = dirname(fileURLToPath(import.meta.url));
const CUSTOM = join(TOOLS, "custom");
const OUT = resolve(TOOLS, "../../src/ui/file-icons/atom-icons");
const ICONS_OUT = join(OUT, "icons");

/** Upstream SVG paths of one asset folder by lowercased basename. */
function svgsIn(folder) {
  const byName = new Map();
  for (const file of readdirSync(join(ASSETS, folder)).filter((name) => name.endsWith(".svg")).sort()) {
    const name = file.slice(0, -".svg".length).toLowerCase();
    if (byName.has(name)) console.warn(`${folder}/${file} differs from ${byName.get(name)} only in case; keeping the first`);
    else byName.set(name, join(ASSETS, folder, file));
  }
  return byName;
}

const files = svgsIn("files");
const folders = svgsIn("folders");
const foldersOpen = svgsIn("foldersOpen");

rmSync(ICONS_OUT, { recursive: true, force: true });
mkdirSync(ICONS_OUT, { recursive: true });

const icons = new Map();
for (const [name, path] of files) {
  icons.set(name, path);
}
for (const [name, path] of folders) {
  const open = foldersOpen.get(name);
  if (!open) {
    console.warn(`skipping folder ${name}: no open state upstream`);
    continue;
  }
  icons.set(`folder_${name}`, path);
  icons.set(`folder_${name}_open`, open);
}
for (const [name, folder, upstream] of FALLBACKS) {
  const path = { files, folders, foldersOpen }[folder].get(upstream);
  if (!path) throw new Error(`upstream ships no ${folder}/${upstream}.svg`);
  icons.set(name, path);
}
for (const file of readdirSync(join(CUSTOM, "icons")).filter((name) => name.endsWith(".svg")).sort()) {
  const name = file.slice(0, -".svg".length);
  if (icons.has(name)) {
    console.warn(`custom ${file} is shadowed by the upstream icon of the same name`);
    continue;
  }
  icons.set(name, join(CUSTOM, "icons", file));
}

const stats = { icons: 0, colors: 0 };
const inlined = [];
for (const [name, path] of [...icons].sort(([a], [b]) => a.localeCompare(b))) {
  const svg = pastelSvg(cleanSvg(readFileSync(path, "utf8")));
  writeFileSync(join(ICONS_OUT, `${name}.svg`), svg);
  stats.icons++;
  inlined.push({ name, svg });
}

const shipped = new Set(icons.keys());
const fileIcons = await loadDefinitions("files");
const folderIcons = await loadDefinitions("folders");
const fileNames = {};
const fileExtensions = {};
for (const icon of fileIcons) {
  if (icon.disabled || icon.enabledFor) continue;
  const name = icon.name.toLowerCase();
  const target = icon.light && shipped.has(`${name}_dark`) ? `${name}_dark` : name;
  for (const fileName of icon.fileNames ?? []) {
    fileNames[fileName] = target;
  }
  for (const extension of icon.fileExtensions ?? []) {
    fileExtensions[extension] = target;
  }
}
const folderNames = {};
for (const icon of folderIcons) {
  if (icon.disabled || icon.enabledFor) continue;
  for (const folderName of icon.folderNames ?? []) {
    for (const key of [folderName, `.${folderName}`, `_${folderName}`]) {
      folderNames[key] = `folder_${icon.name.toLowerCase()}`;
    }
  }
}

const customAssociations = join(CUSTOM, "associations.json");
const custom = existsSync(customAssociations) ? JSON.parse(readFileSync(customAssociations, "utf8")) : {};
const commit = (clone) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: clone, encoding: "utf8" }).trim();
const associations = {
  source: {
    svgs: { repository: SVG_REPOSITORY, commit: commit(SVG_CLONE) },
    associations: { repository: ASSOCIATION_REPOSITORY, commit: commit(ASSOCIATION_CLONE) },
    pastel: PASTEL,
  },
  fileNames: lowercaseKeys({ ...fileNames, ...custom.fileNames }, shipped),
  fileExtensions: lowercaseKeys({ ...fileExtensions, ...custom.fileExtensions }, shipped),
  folderNames: lowercaseKeys({ ...folderNames, ...custom.folderNames }, shipped),
};
writeFileSync(join(OUT, "associations.json"), JSON.stringify(associations, null, 2) + "\n");
copyFileSync(join(SVG_CLONE, "LICENSE"), join(OUT, "LICENSE"));

const preview = join(tmpdir(), "atom-icons-preview.html");
writeFileSync(preview, previewHtml(inlined));
console.log(
  `${stats.icons} icons, ${stats.colors} colors made pastel; ${Object.keys(associations.fileNames).length} file names, ` +
    `${Object.keys(associations.fileExtensions).length} extensions, ${Object.keys(associations.folderNames).length} folder names; preview: ${preview}`,
);

/**
 * Icon definitions of one upstream folder (`src/icons/files` or `src/icons/folders`): every exported array of every
 * module (an array, or one definition for a letter with a single folder icon), in the order of the folder's index. Types are stripped; the `IconPack` enum is stubbed with its member names.
 */
async function loadDefinitions(kind) {
  const folder = join(ASSOCIATION_CLONE, "src/icons", kind);
  const index = readFileSync(join(folder, "index.ts"), "utf8");
  const modules = [...index.matchAll(/from '\.\/([^']+)'/g)].map((match) => match[1]);
  const definitions = [];
  for (const module of modules) {
    const source = stripTypeScriptTypes(readFileSync(join(folder, `${module}.ts`), "utf8"), { mode: "transform" }).replace(
      /^import\s*\{\s*IconPack\s*\}\s*from\s*'[^']+';?$/m,
      "const IconPack = new Proxy({}, { get: (_, member) => member });",
    );
    if (/^import\s/m.test(source)) throw new Error(`${kind}/${module}.ts imports more than IconPack`);
    const exports = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    for (const value of Object.values(exports)) {
      definitions.push(...[value].flat());
    }
  }
  return definitions;
}

/** Lowercases the keys of an association map and drops entries whose icon is not shipped. */
function lowercaseKeys(map, shipped) {
  const result = {};
  for (const [key, icon] of Object.entries(map).sort(([a], [b]) => a.localeCompare(b))) {
    if (!shipped.has(icon)) {
      console.warn(`skipping ${key}: ${icon}.svg is not shipped upstream`);
      continue;
    }
    result[key.toLowerCase()] = icon;
  }
  return result;
}

/** Drops comments (upstream repeats its license in each file), the XML prolog and upstream's data-* color tags. */
function cleanSvg(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/\s+data-[\w-]+="[^"]*"/g, "")
    .replace(/^\s+/, "");
}

/** Rewrites every hex color of a paint property, as an attribute or inside a style declaration, to its pastel version. */
function pastelSvg(svg) {
  const pastelHex = (hex) => {
    stats.colors++;
    return pastel(hex);
  };
  return svg
    .replace(/(\s(?:fill|stroke|stop-color|flood-color|color)=")(#[0-9a-fA-F]{3,8})(?=")/g, (_, prefix, hex) => prefix + pastelHex(hex))
    .replace(/((?:^|[;{\s"])(?:fill|stroke|stop-color|flood-color|color)\s*:\s*)(#[0-9a-fA-F]{3,8})\b/g, (_, prefix, hex) => prefix + pastelHex(hex));
}

/** The pastel version of a #rgb, #rgba, #rrggbb or #rrggbbaa color; alpha is kept. */
function pastel(hex) {
  const digits = hex.length <= 5 ? [...hex.slice(1)].map((digit) => digit + digit).join("") : hex.slice(1);
  const rgb = [0, 2, 4].map((offset) => parseInt(digits.slice(offset, offset + 2), 16) / 255);
  const alpha = digits.slice(6);
  const [lightness, chroma, hue] = toOklch(rgb);
  const liftedLightness = lightness + (1 - lightness) * (PASTEL / 2);
  let liftedChroma = lightness >= LIGHT_ENOUGH ? chroma : chroma * (1 - 0.4 * PASTEL);
  let result = fromOklch([liftedLightness, liftedChroma, hue]);
  while (result.some((channel) => channel < -0.0005 || channel > 1.0005) && liftedChroma > 0.001) {
    liftedChroma *= 0.95;
    result = fromOklch([liftedLightness, liftedChroma, hue]);
  }
  const channel = (value) => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, "0");
  return `#${result.map(channel).join("")}${alpha}`;
}

function toOklch(rgb) {
  const [r, g, b] = rgb.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bAxis = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [lightness, Math.hypot(a, bAxis), Math.atan2(bAxis, a)];
}

function fromOklch([lightness, chroma, hue]) {
  const a = chroma * Math.cos(hue);
  const bAxis = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * bAxis) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * bAxis) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * bAxis) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return linear.map((value) => (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055));
}

function previewHtml(icons) {
  const cells = icons
    .map(({ name, svg }) => `<figure title="${name}"><div class="lg">${svg}</div><div class="sm">${svg}</div><figcaption>${name}</figcaption></figure>`)
    .join("\n");
  return `<!doctype html>
<meta charset="utf-8">
<title>Atom Material Icons, pastel ${PASTEL}</title>
<style>
  body { margin: 0; font: 12px system-ui, sans-serif; color: #cdd6f4; background: #21252d; }
  header { position: sticky; top: 0; display: flex; gap: 16px; align-items: center; padding: 10px 16px; background: #1b1e25; border-bottom: 1px solid #363c47; }
  main { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 6px; padding: 12px; }
  figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 8px 4px; border-radius: 6px; background: var(--bg, #21252d); }
  figcaption { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #9099a8; }
  .lg svg { width: 48px; height: 48px; } .sm svg { width: 16px; height: 16px; }
</style>
<header>
  <label>Background <select id="bg"><option value="#21252d">chat</option><option value="#1b1e25">inset</option><option value="#272c35">inspector</option><option value="#ffffff">white</option></select></label>
  <label>Filter <input id="q" type="search"></label>
  <span>${icons.length} icons, pastel ${PASTEL}</span>
</header>
<main>
${cells}
</main>
<script>
  document.getElementById("bg").onchange = (e) => document.querySelectorAll("figure").forEach((f) => f.style.setProperty("--bg", e.target.value));
  document.getElementById("q").oninput = (e) => document.querySelectorAll("figure").forEach((f) => (f.hidden = !f.title.includes(e.target.value)));
</script>
`;
}
