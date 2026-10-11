#!/usr/bin/env node
/**
 * Vendors the Catppuccin icon set (github.com/catppuccin/vscode-icons) into src/diff/catppuccinIcons as a
 * filled variant of the upstream outline icons.
 *
 * Usage: node tools/icons/syncCatppuccinIcons.mjs <path-to-vscode-icons-clone> [flavor] [fill-opacity]
 *   flavor        mocha (default), macchiato, frappe or latte
 *   fill-opacity  0..1, default 0.35
 *
 * Every closed shape (circle, ellipse, rect, and each path subpath that ends with Z or returns to its
 * start point) is filled with its own stroke color at the given opacity. Open subpaths such as the
 * letter strokes of language icons stay unfilled; a path mixing both kinds is split into two paths.
 * Shapes inside <defs>, <mask> and <clipPath> and shapes with an explicit fill are left untouched.
 *
 * Folder icons with a glyph (folder_src, folder_api, ...) become solid folders instead: the outline is replaced
 * by a silhouette in the glyph's accent color (the most used stroke color of the glyph) and the glyph is drawn
 * in the flavor's text color over a dark halo, so it stays readable where it crosses the folder's edge. Open
 * folders get a darker body behind the lifted front. The generic folder (_folder) and the project root keep
 * their outline, so colored folders stand out.
 *
 * Hunt-specific icons (outlines in the same style) live in tools/icons/custom/icons and are filled the
 * same way; the file icon rules in src/state/settings.ts assign them. An optional tools/icons/custom/associations.json
 * ({ fileNames?, fileExtensions?, folderNames? }) is merged on top of the upstream defaults.
 *
 * Output (fully regenerated on every run):
 *   icons/*.svg        all icons of the flavor plus the custom ones, filled
 *   associations.json  { source, fileNames, fileExtensions, folderNames } from the upstream defaults and
 *                      the custom overrides (lowercase keys, values are icon basenames without ".svg")
 *   LICENSE            upstream license
 * A preview page inlining every icon is written to the OS temp directory; its path is printed.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY = "https://github.com/catppuccin/vscode-icons.git";
/** Extensions of VS Code language ids that upstream associates without listing any extension. */
const LANGUAGE_EXTENSIONS = { diff: ["diff", "patch"] };
/** The `text` color every outline is drawn in and the `crust` color the glyph halos are darkened towards, per flavor. */
const FLAVOR_COLORS = {
  mocha: { text: "#cdd6f4", crust: "#11111b" },
  macchiato: { text: "#cad3f5", crust: "#181926" },
  frappe: { text: "#c6d0f5", crust: "#232634" },
  latte: { text: "#4c4f69", crust: "#dce0e8" },
};
/** Silhouette of a closed folder (the tab at the top left included), the outline upstream draws around it. */
const FOLDER_SHAPE = "M4.5 4.5H12c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5H2A1.5 1.5 0 01.5 12V3.5a1 1 0 011-1h5a1 1 0 011 1v1Z";
/** The lifted front of an open folder; drawn over FOLDER_SHAPE, which then is the body behind it. */
const FOLDER_FRONT_SHAPE = "M1.87 8l.7-2.74a1 1 0 01.96-.76h10.94a1 1 0 01.97 1.24l-1.75 7a1 1 0 01-.97.76H2Z";
/** How far the open folder's body (first) and the glyph halo (second) are darkened towards `crust`. */
const BODY_SHADE = 0.3;
const HALO_SHADE = 0.6;
/** Width of the halo stroke under a glyph stroke of width 1. */
const HALO_WIDTH = 3;
/** Grey glyph strokes (the flavors' overlay colors) only become the accent when no other color is used. */
const NEUTRAL_STROKES = new Set(["#7f849c", "#6c7086", "#9399b2", "#8087a2", "#737994", "#a5adce", "#8c8fa1", "#7c7f93", "#6c6f85"]);

const [, , clonePath, flavor = "mocha", opacityArg = "0.35"] = process.argv;
if (!clonePath) throw new Error("usage: syncCatppuccinIcons.mjs <vscode-icons-clone> [flavor] [fill-opacity]");
if (!FLAVOR_COLORS[flavor]) throw new Error(`unknown flavor ${flavor}; expected one of ${Object.keys(FLAVOR_COLORS).join(", ")}`);
const FILL_OPACITY = Number(opacityArg);
const CLONE = resolve(clonePath);
const SRC = join(CLONE, "icons", flavor);
const TOOLS = dirname(fileURLToPath(import.meta.url));
const CUSTOM = join(TOOLS, "custom");
const OUT = resolve(TOOLS, "../../src/diff/catppuccinIcons");
const ICONS_OUT = join(OUT, "icons");

rmSync(ICONS_OUT, { recursive: true, force: true });
mkdirSync(ICONS_OUT, { recursive: true });

const sources = [
  ...readdirSync(SRC).filter((name) => name.endsWith(".svg")).sort().map((name) => join(SRC, name)),
  ...readdirSync(join(CUSTOM, "icons")).filter((name) => name.endsWith(".svg")).sort().map((name) => join(CUSTOM, "icons", name)),
];
const names = [];
const stats = { icons: 0, filledShapes: 0, splitPaths: 0, solidFolders: 0, untouched: [] };
const inlined = [];
for (const source of sources) {
  const name = basename(source);
  const { svg: filledSvg, filled } = fillSvg(readFileSync(source, "utf8"));
  const solid = name.startsWith("folder_") ? solidFolderSvg(filledSvg, name.endsWith("_open.svg")) : null;
  const svg = solid ?? filledSvg;
  writeFileSync(join(ICONS_OUT, name), svg);
  names.push(name);
  stats.icons++;
  stats.filledShapes += filled;
  if (solid) stats.solidFolders++;
  if (!filled && !solid) stats.untouched.push(name);
  inlined.push({ name: name.replace(/\.svg$/, ""), svg });
}

const fileDefaults = await import(pathToFileURL(join(CLONE, "src/defaults/fileIcons.ts")).href);
const folderDefaults = await import(pathToFileURL(join(CLONE, "src/defaults/folderIcons.ts")).href);
const fileExtensions = { ...fileDefaults.fileExtensions };
for (const [languageId, icon] of Object.entries(fileDefaults.languageIds)) {
  for (const extension of LANGUAGE_EXTENSIONS[languageId] ?? []) {
    fileExtensions[extension] ??= icon;
  }
}
const customAssociations = join(CUSTOM, "associations.json");
const custom = existsSync(customAssociations) ? JSON.parse(readFileSync(customAssociations, "utf8")) : {};
const shipped = new Set(names.map((name) => name.replace(/\.svg$/, "")));
const associations = {
  source: { repository: REPOSITORY, commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: CLONE, encoding: "utf8" }).trim(), flavor, fillOpacity: FILL_OPACITY },
  fileNames: lowercaseKeys({ ...fileDefaults.fileNames, ...custom.fileNames }, shipped),
  fileExtensions: lowercaseKeys({ ...fileExtensions, ...custom.fileExtensions }, shipped),
  folderNames: lowercaseKeys({ ...folderDefaults.folderNames, ...custom.folderNames }, shipped),
};
for (const required of ["_file", "_folder", "_folder_open", "_root", "_root_open"]) {
  if (!shipped.has(required)) throw new Error(`upstream ships no ${required}.svg`);
}
writeFileSync(join(OUT, "associations.json"), JSON.stringify(associations, null, 2) + "\n");
copyFileSync(join(CLONE, "LICENSE"), join(OUT, "LICENSE"));

const preview = join(tmpdir(), `catppuccin-${flavor}-preview.html`);
writeFileSync(preview, previewHtml(flavor, inlined));
console.log(
  `${stats.icons} icons, ${stats.filledShapes} filled shapes, ${stats.splitPaths} paths split, ${stats.solidFolders} solid folders; ` +
    `${Object.keys(associations.fileNames).length} file names, ${Object.keys(associations.fileExtensions).length} extensions, ` +
    `${Object.keys(associations.folderNames).length} folder names; preview: ${preview}`,
);
console.log(`no closed shape in: ${stats.untouched.join(", ") || "none"}`);

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

/** Rewrites one SVG document; returns the new markup and the number of shapes that received a fill. */
function fillSvg(source) {
  const CLOSED_TAGS = new Set(["circle", "ellipse", "rect", "polygon"]);
  const SKIP_TAGS = new Set(["defs", "mask", "clipPath"]);
  const stack = [];
  let filled = 0;
  const svg = source.replace(/<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g, (tag, isClose, tagName, attrs, selfClosing) => {
    if (isClose) {
      stack.pop();
      return tag;
    }
    const parentStroke = stack.length ? stack[stack.length - 1].stroke : undefined;
    const inSkipped = stack.some((frame) => frame.skipped);
    const own = attr(attrs, "stroke");
    const stroke = own && own !== "none" ? own : parentStroke;
    const frame = { stroke, skipped: inSkipped || SKIP_TAGS.has(tagName) };
    if (!selfClosing) stack.push(frame);
    if (frame.skipped || !stroke || !stroke.startsWith("#")) return tag;
    if (attr(attrs, "fill") && attr(attrs, "fill") !== "none") return tag;

    if (CLOSED_TAGS.has(tagName)) {
      filled++;
      return `<${tagName}${withFill(attrs, stroke)}${selfClosing}>`;
    }
    if (tagName !== "path") return tag;
    const d = attr(attrs, "d");
    if (!d) return tag;
    const { closed, open } = splitSubpaths(d);
    if (!closed.length) return tag;
    filled++;
    const rest = attrs.replace(/\s*d="[^"]*"/, "").trimEnd();
    const closedPath = `<path${withFill(rest, stroke)} d="${closed.join(" ")}"${selfClosing}>`;
    if (!open.length) return closedPath;
    stats.splitPaths++;
    return `${closedPath}\n\t\t<path${rest} d="${open.join(" ")}"${selfClosing}>`;
  });
  return { svg, filled };
}

/**
 * Rewrites a folder icon with a glyph into a solid folder: the outline (the first path in the flavor's text
 * color) becomes a silhouette in the glyph's accent color, the glyph is drawn in the text color over a halo
 * darkened towards crust. Returns null for a folder without a colored glyph, which keeps its outline.
 */
function solidFolderSvg(source, isOpen) {
  const { text, crust } = FLAVOR_COLORS[flavor];
  const match = source.match(/^([\s\S]*?<svg[^>]*>)([\s\S]*)(<\/svg>\s*)$/);
  if (!match) throw new Error("not an svg document");
  const [, head, body, tail] = match;
  const stack = [];
  const useByColor = new Map();
  let hasOutline = false;
  const glyph = body.replace(/<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g, (tag, isClose, tagName, attrs, selfClosing) => {
    if (isClose) {
      stack.pop();
      return tag;
    }
    const own = attr(attrs, "stroke");
    const stroke = own && own !== "none" ? own : stack[stack.length - 1];
    if (!selfClosing) stack.push(stroke);
    if (tagName === "g") return tag;
    if (!hasOutline && tagName === "path" && stroke === text) {
      hasOutline = true;
      return "";
    }
    if (stroke && stroke !== text && stroke.startsWith("#")) {
      useByColor.set(stroke, (useByColor.get(stroke) ?? 0) + 1);
    }
    return tag;
  });
  if (!hasOutline || !useByColor.size) return null;
  const weight = ([color, uses]) => (NEUTRAL_STROKES.has(color) ? uses / 100 : uses);
  const accent = [...useByColor.entries()].sort((a, b) => weight(b) - weight(a))[0][0];
  const halo = glyph
    .replace(/\s*(?:stroke|fill|fill-opacity)="[^"]*"/g, "")
    .replace(/\sstroke-width="([^"]*)"/g, (_, width) => ` stroke-width="${fmt(Number(width) + HALO_WIDTH - 1)}"`);
  const light = glyph.replace(/\s*stroke="[^"]*"/g, "").replace(/fill="#[0-9a-fA-F]*"/g, `fill="${text}"`);
  const trim = (markup) => markup.replace(/\n\s*\n/g, "\n").replace(/^\n|\n\s*$/g, "");
  const folder = isOpen ? `\t<path fill="${mix(accent, crust, BODY_SHADE)}" d="${FOLDER_SHAPE}"/>\n\t<path fill="${accent}" d="${FOLDER_FRONT_SHAPE}"/>` : `\t<path fill="${accent}" d="${FOLDER_SHAPE}"/>`;
  return (
    `${head}\n${folder}\n` +
    `\t<g fill="none" stroke="${mix(accent, crust, HALO_SHADE)}" stroke-width="${HALO_WIDTH}" stroke-linecap="round" stroke-linejoin="round">\n${trim(halo)}\n\t</g>\n` +
    `\t<g fill="none" stroke="${text}" stroke-linecap="round" stroke-linejoin="round">\n${trim(light)}\n\t</g>\n${tail}`
  );
}

/** The hex color `amount` (0..1) of the way from `from` to `to`. */
function mix(from, to, amount) {
  const channel = (offset) => Math.round(parseInt(from.slice(offset, offset + 2), 16) * (1 - amount) + parseInt(to.slice(offset, offset + 2), 16) * amount);
  return `#${[1, 3, 5].map((offset) => channel(offset).toString(16).padStart(2, "0")).join("")}`;
}

function attr(attrs, name) {
  const match = attrs.match(new RegExp(`\\s${name}="([^"]*)"`));
  return match ? match[1] : undefined;
}

/** Replaces or adds the fill attributes so the shape is tinted with its stroke color. */
function withFill(attrs, color) {
  const stripped = attrs.replace(/\s*fill="[^"]*"/, "").replace(/\s*fill-opacity="[^"]*"/, "").trimEnd();
  return `${stripped} fill="${color}" fill-opacity="${FILL_OPACITY}"`;
}

/**
 * Splits path data into closed and open subpaths, each re-emitted with an absolute initial moveto so
 * the two groups can live in separate path elements. Arc flags are read as single digits as the SVG
 * grammar allows ("a6.5 6.5 0 100-13").
 */
function splitSubpaths(d) {
  const ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  const NUMBER = /[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/y;
  const closed = [];
  const open = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let current = null;
  let command = null;
  let position = 0;

  const skipSeparators = () => {
    while (position < d.length && /[\s,]/.test(d[position])) position++;
  };
  const readNumber = (isFlag) => {
    skipSeparators();
    if (isFlag) return Number(d[position++]);
    NUMBER.lastIndex = position;
    const match = NUMBER.exec(d);
    if (!match) throw new Error(`bad path data at ${position}: ${d}`);
    position = NUMBER.lastIndex;
    return Number(match[0]);
  };
  const flush = () => {
    if (!current) return;
    const isClosed = current.closed || (Math.abs(x - startX) < 0.01 && Math.abs(y - startY) < 0.01);
    (isClosed ? closed : open).push(current.text);
    current = null;
  };

  while (true) {
    skipSeparators();
    if (position >= d.length) break;
    if (/[a-zA-Z]/.test(d[position])) {
      command = d[position++];
      if (command.toUpperCase() === "Z") {
        current.closed = true;
        current.text += "Z";
        x = startX;
        y = startY;
        continue;
      }
    } else if (command.toUpperCase() === "M") {
      command = command === "M" ? "L" : "l";
    }
    const upper = command.toUpperCase();
    const relative = command !== upper;
    const args = [];
    for (let argIndex = 0; argIndex < ARITY[upper]; argIndex++) {
      args.push(readNumber(upper === "A" && (argIndex === 3 || argIndex === 4)));
    }
    const base = relative ? [x, y] : [0, 0];

    if (upper === "M") {
      flush();
      x = base[0] + args[0];
      y = base[1] + args[1];
      startX = x;
      startY = y;
      current = { closed: false, text: `M${fmt(x)} ${fmt(y)}` };
      continue;
    }
    current.text += `${command}${args.map(fmt).join(" ")}`;
    if (upper === "H") x = base[0] + args[0];
    else if (upper === "V") y = base[1] + args[0];
    else {
      x = base[0] + args[args.length - 2];
      y = base[1] + args[args.length - 1];
    }
  }
  flush();
  return { closed, open };
}

function fmt(value) {
  return String(Number(value.toFixed(4)));
}

function previewHtml(flavorName, icons) {
  const cells = icons
    .map(({ name, svg }) => `<figure title="${name}"><div class="lg">${svg}</div><div class="sm">${svg}</div><figcaption>${name}</figcaption></figure>`)
    .join("\n");
  return `<!doctype html>
<meta charset="utf-8">
<title>Catppuccin ${flavorName} filled</title>
<style>
  :root { --o: ${FILL_OPACITY}; }
  body { margin: 0; font: 12px system-ui, sans-serif; color: #cdd6f4; background: #21252d; }
  header { position: sticky; top: 0; display: flex; gap: 16px; align-items: center; padding: 10px 16px; background: #1b1e25; border-bottom: 1px solid #363c47; }
  input[type=range] { width: 200px; }
  main { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 6px; padding: 12px; }
  figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 8px 4px; border-radius: 6px; background: var(--bg, #21252d); }
  figcaption { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #9099a8; }
  .lg svg { width: 48px; height: 48px; } .sm svg { width: 16px; height: 16px; }
  [fill-opacity] { fill-opacity: var(--o); }
  body.nofill [fill-opacity] { fill-opacity: 0; }
</style>
<header>
  <label>Fill opacity <input id="o" type="range" min="0" max="1" step="0.05" value="${FILL_OPACITY}"> <output id="ov">${FILL_OPACITY}</output></label>
  <label>Background <select id="bg"><option value="#21252d">chat</option><option value="#1b1e25">inset</option><option value="#272c35">inspector</option><option value="#ffffff">white</option></select></label>
  <label><input id="nf" type="checkbox"> outline only</label>
  <span>${icons.length} icons</span>
</header>
<main>
${cells}
</main>
<script>
  const o = document.getElementById("o"), ov = document.getElementById("ov");
  o.oninput = () => { document.documentElement.style.setProperty("--o", o.value); ov.textContent = o.value; };
  document.getElementById("bg").onchange = (e) => document.querySelectorAll("figure").forEach((f) => f.style.setProperty("--bg", e.target.value));
  document.getElementById("nf").onchange = (e) => document.body.classList.toggle("nofill", e.target.checked);
</script>
`;
}
