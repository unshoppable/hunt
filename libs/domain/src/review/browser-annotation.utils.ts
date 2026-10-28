/**
 * An annotation a person makes with the review widget on a guarded preview page of a session VM or in the Chrome of a
 * local session: the element they picked and what they wrote about it. On a VM the review server
 * (`apps/session/src/review/review-server.service.ts`) validates and stores it and the status helper delivers it once to
 * the desktop client; a local Chrome hands it to the desktop client through a CDP binding. The client shows it above the
 * session's composer and sends it along with the next prompt.
 */
import { isRecord } from "../shared/json-rpc.utils.ts";

export interface AnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the picked element is rendered in the app's sources, as far as the page tells (React's debug info, data attributes). */
export interface AnnotationSource {
  file: string;
  line: number;
  column?: number;
}

export interface BrowserAnnotation {
  /** The page's URL. */
  url: string;
  /** The page's title. */
  title: string;
  /** A CSS selector that matches the picked element only. */
  selector: string;
  /** The element's visible text, shortened. */
  text: string;
  /** The element's HTML, shortened. */
  outerHtml: string;
  /** The element's box in CSS pixels of the viewport. */
  rect: AnnotationRect;
  viewport: { width: number; height: number };
  /** A few computed styles of the element that tell its look, by CSS property. */
  styles: Record<string, string>;
  source?: AnnotationSource;
  comment: string;
}

/** An annotation as the review server stores and the status helper delivers it. */
export interface StoredBrowserAnnotation extends BrowserAnnotation {
  /** A random UUID the review server assigns. */
  id: string;
  /** When the review server received it, in ms since the epoch. */
  createdAt: number;
}

/** The longest value of each text field; the widget shortens its values to these. */
export const ANNOTATION_LIMITS = {
  url: 2048,
  title: 512,
  selector: 1024,
  text: 1000,
  outerHtml: 4000,
  comment: 4000,
  sourceFile: 512,
  styleCount: 32,
  styleName: 64,
  styleValue: 256,
} as const;

export type AnnotationResult = { annotation: BrowserAnnotation } | { error: string };

/** `value` as a BrowserAnnotation, or the first problem found; unknown fields are dropped. */
export function parseBrowserAnnotation(value: unknown): AnnotationResult {
  if (!isRecord(value)) return { error: "the annotation must be an object" };
  const problems: string[] = [];
  const text = (field: "url" | "title" | "selector" | "text" | "outerHtml" | "comment", limit: number, isRequired: boolean): string => {
    const entry = value[field];
    if (typeof entry !== "string" || entry.length > limit || (isRequired && !entry.trim())) {
      problems.push(`${field} must be a ${isRequired ? "non-empty " : ""}string of at most ${limit} characters`);
      return "";
    }
    return entry;
  };
  const annotation: BrowserAnnotation = {
    url: text("url", ANNOTATION_LIMITS.url, true),
    title: text("title", ANNOTATION_LIMITS.title, false),
    selector: text("selector", ANNOTATION_LIMITS.selector, true),
    text: text("text", ANNOTATION_LIMITS.text, false),
    outerHtml: text("outerHtml", ANNOTATION_LIMITS.outerHtml, false),
    rect: numbers(value.rect, ["x", "y", "width", "height"], "rect", problems),
    viewport: numbers(value.viewport, ["width", "height"], "viewport", problems),
    styles: styles(value.styles, problems),
    comment: text("comment", ANNOTATION_LIMITS.comment, true),
  };
  if (value.source !== undefined) {
    const source = parseSource(value.source);
    if (source) {
      annotation.source = source;
    } else {
      problems.push("source must hold a file and a line, optionally a column");
    }
  }
  if (problems.length > 0) return { error: problems[0] };
  return { annotation };
}

/** `value` as a StoredBrowserAnnotation; undefined when it is none. */
export function parseStoredBrowserAnnotation(value: unknown): StoredBrowserAnnotation | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id || typeof value.createdAt !== "number") return undefined;
  const result = parseBrowserAnnotation(value);
  if ("error" in result) return undefined;
  return { id: value.id, createdAt: value.createdAt, ...result.annotation };
}

/** The finite numbers `keys` of the object `value`, else a problem; NaN and Infinity are no JSON. */
function numbers<Key extends string>(value: unknown, keys: readonly Key[], field: string, problems: string[]): Record<Key, number> {
  const result = {} as Record<Key, number>;
  for (const key of keys) {
    const entry = isRecord(value) ? value[key] : undefined;
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      problems.push(`${field} must hold the numbers ${keys.join(", ")}`);
      return result;
    }
    result[key] = entry;
  }
  return result;
}

function styles(value: unknown, problems: string[]): Record<string, string> {
  const entries = isRecord(value) ? Object.entries(value) : undefined;
  const isValid =
    entries &&
    entries.length <= ANNOTATION_LIMITS.styleCount &&
    entries.every(
      ([name, style]) =>
        /^-?[a-z][a-z-]*$/.test(name) && name.length <= ANNOTATION_LIMITS.styleName && typeof style === "string" && style.length <= ANNOTATION_LIMITS.styleValue,
    );
  if (!isValid) {
    problems.push(`styles must map at most ${ANNOTATION_LIMITS.styleCount} CSS properties to strings`);
    return {};
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function parseSource(value: unknown): AnnotationSource | undefined {
  if (!isRecord(value)) return undefined;
  const { file, line, column } = value;
  if (typeof file !== "string" || !file || file.length > ANNOTATION_LIMITS.sourceFile) return undefined;
  if (!isLineNumber(line)) return undefined;
  if (column === undefined) return { file, line };
  if (!isLineNumber(column)) return undefined;
  return { file, line, column };
}

function isLineNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000_000;
}
