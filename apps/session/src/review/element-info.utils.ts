/**
 * What the review widget (`review-widget.main.ts`) tells about a picked element, without touching the DOM: the widget
 * describes the element and its ancestors as plain values and passes lookups as functions, so this runs and is tested
 * in Node.
 */
import { ANNOTATION_LIMITS, type AnnotationSource } from "../../../../libs/domain/src/review/browser-annotation.utils.ts";

/** One element of the chain from the picked element up to the document's root element, as `cssSelector` needs it. */
export interface ElementStep {
  /** Lowercase. */
  tagName: string;
  id: string;
  classNames: readonly string[];
  /** 1-based position among the siblings with the same tag name. */
  indexOfType: number;
  /** How many siblings, the element included, share its tag name. */
  countOfType: number;
}

/** The computed styles an annotation carries, in this order, when they say something about the element's look. */
export const STYLE_PROPERTIES = [
  "display",
  "position",
  "width",
  "height",
  "margin",
  "padding",
  "gap",
  "flex-direction",
  "justify-content",
  "align-items",
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "text-align",
  "border",
  "border-radius",
  "box-shadow",
  "opacity",
  "z-index",
] as const;

/** Values that tell nothing beyond the browser's default. */
const UNINFORMATIVE_STYLES = new Set(["", "none", "normal", "auto", "0px", "rgba(0, 0, 0, 0)", "static", "visible", "1", "start", "row"]);
/** An id or class that is a valid CSS identifier as is, so it needs no escaping. */
const PLAIN_IDENTIFIER = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;
/** Class names that only reflect a state or are generated per build, which make a selector break on the next render. */
const VOLATILE_CLASS = /^(hover|focus|active|selected|open|is-|has-|ng-|css-|sc-|jsx-|_)|[0-9a-f]{5,}|__/;
const MAX_CLASSES_PER_STEP = 2;
const MAX_FIBER_DEPTH = 30;

/**
 * A CSS selector that matches only the first element of `chain` (the picked element, then its ancestors up to the
 * root element), as short as `isUnique` allows: an id that is unique on its own, else steps of tag name, up to two
 * stable classes and `:nth-of-type` joined by `>`, from the element upwards until the selector is unique or reaches an
 * ancestor with a unique id.
 */
export function cssSelector(chain: readonly ElementStep[], isUnique: (selector: string) => boolean): string {
  const steps: string[] = [];
  for (const step of chain) {
    if (isPlainIdentifier(step.id) && isUnique(`#${step.id}`)) {
      steps.unshift(`#${step.id}`);
      return steps.join(" > ");
    }
    const classes = step.classNames.filter((name) => isPlainIdentifier(name) && !VOLATILE_CLASS.test(name)).slice(0, MAX_CLASSES_PER_STEP);
    const nth = step.countOfType > 1 ? `:nth-of-type(${step.indexOfType})` : "";
    steps.unshift(`${step.tagName}${classes.map((name) => `.${name}`).join("")}${nth}`);
    const selector = steps.join(" > ");
    if (isUnique(selector)) return selector;
  }
  return steps.join(" > ");
}

function isPlainIdentifier(value: string): boolean {
  return PLAIN_IDENTIFIER.test(value) && !/^-?[0-9]/.test(value);
}

/** `text` with runs of whitespace collapsed and cut to `limit` characters, the cut marked with `…`. */
export function shorten(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 1)}…`;
}

/** `html` cut to `limit` characters, the cut marked with `…`; whitespace stays, since it may matter in markup. */
export function shortenHtml(html: string, limit: number = ANNOTATION_LIMITS.outerHtml): string {
  if (html.length <= limit) return html;
  return `${html.slice(0, limit - 1)}…`;
}

/** The STYLE_PROPERTIES whose computed value (`valueOf`) says more than the browser's default. */
export function pickStyles(valueOf: (property: string) => string): Record<string, string> {
  const styles: Record<string, string> = {};
  for (const property of STYLE_PROPERTIES) {
    const value = valueOf(property).trim();
    if (UNINFORMATIVE_STYLES.has(value)) continue;
    styles[property] = shorten(value, ANNOTATION_LIMITS.styleValue);
  }
  return styles;
}

/**
 * Where React rendered `element` (a DOM element as a plain object): the `_debugSource` of its fiber or the nearest
 * owner's (React 18 and older in development), else the first application frame of the `_debugStack` React 19 keeps
 * in development, whose line is that of the module the dev server serves. Undefined in production builds and for
 * pages without React.
 */
export function reactSource(element: object): AnnotationSource | undefined {
  const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
  if (!fiberKey) return undefined;
  let fiber = (element as Record<string, unknown>)[fiberKey];
  for (let depth = 0; depth < MAX_FIBER_DEPTH && isObject(fiber); depth++) {
    const source = debugSource(fiber._debugSource) ?? stackSource(fiber._debugStack) ?? stackSource(ownerOf(fiber)?._debugStack);
    if (source) return source;
    fiber = fiber.return;
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function ownerOf(fiber: Record<string, unknown>): Record<string, unknown> | undefined {
  return isObject(fiber._debugOwner) ? fiber._debugOwner : undefined;
}

function debugSource(value: unknown): AnnotationSource | undefined {
  if (!isObject(value) || typeof value.fileName !== "string" || typeof value.lineNumber !== "number") return undefined;
  return withColumn(value.fileName, value.lineNumber, value.columnNumber);
}

/** A frame of an Error's stack in Chrome's or Firefox's format: the URL, line and column. */
const STACK_FRAME = /(?:\(|@|at )((?:https?|file):\/\/[^\s()]+?):(\d+):(\d+)\)?\s*$/;
/** Frames of React itself, its JSX runtime or the dev server's dependency bundles. */
const LIBRARY_FRAME = /\/node_modules\/|\/\.vite\/deps\/|react-dom|jsx-dev-runtime|jsx-runtime|react\.development|chunk-[A-Z0-9]+\.js/;

function stackSource(value: unknown): AnnotationSource | undefined {
  const stack = value instanceof Error || isObject(value) ? (value as { stack?: unknown }).stack : undefined;
  if (typeof stack !== "string") return undefined;
  for (const line of stack.split("\n")) {
    const frame = STACK_FRAME.exec(line.trim());
    if (!frame || LIBRARY_FRAME.test(frame[1])) continue;
    return withColumn(pathOfUrl(frame[1]), Number(frame[2]), Number(frame[3]));
  }
  return undefined;
}

/** The path of a module URL the dev server serves, without origin and query: `http://host/src/App.tsx?t=1` → `src/App.tsx`. */
export function pathOfUrl(url: string): string {
  const encoded = url.replace(/^[a-z]+:\/\/[^/]*/, "").replace(/[?#].*$/, "");
  let path = encoded;
  try {
    path = decodeURIComponent(encoded);
  } catch {
    // A malformed escape stays as it is.
  }
  return path.startsWith("/@fs/") ? path.slice("/@fs".length) : path.replace(/^\//, "");
}

/**
 * The source an element names in its attributes (`attributeOf` returns null for a missing one): `data-inspector-*` of
 * react-dev-inspector and similar plugins, or `data-source`/`data-source-location` as `path:line[:column]`.
 */
export function attributeSource(attributeOf: (name: string) => string | null): AnnotationSource | undefined {
  const inspectorPath = attributeOf("data-inspector-relative-path");
  const inspectorLine = attributeOf("data-inspector-line");
  const inspectorColumn = attributeOf("data-inspector-column");
  if (inspectorPath && inspectorLine) return withColumn(inspectorPath, Number(inspectorLine), inspectorColumn === null ? undefined : Number(inspectorColumn));
  for (const name of ["data-source", "data-source-location"]) {
    const match = /^(.+?):(\d+)(?::(\d+))?$/.exec(attributeOf(name) ?? "");
    if (match) return withColumn(match[1], Number(match[2]), match[3] === undefined ? undefined : Number(match[3]));
  }
  return undefined;
}

function withColumn(file: string, line: number, column: unknown): AnnotationSource | undefined {
  if (!file || !Number.isInteger(line) || line < 0) return undefined;
  const source: AnnotationSource = { file: shorten(file, ANNOTATION_LIMITS.sourceFile), line };
  if (typeof column === "number" && Number.isInteger(column) && column >= 0) {
    source.column = column;
  }
  return source;
}
