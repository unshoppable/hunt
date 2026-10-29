import { fillPrompt } from "../../../../../libs/domain/src/shared/prompts.utils.ts";
import browserAnnotationsPrompt from "../../../prompts/chat/browser-annotations.user-prompt.md?raw";
import type { StoredBrowserAnnotation } from "../../../../../libs/domain/src/review/browser-annotation.utils.ts";
import { baseName } from "../../common/path/path.utils";

/** How many of an annotation's computed styles its Markdown block lists at most. */
const MAX_LISTED_STYLES = 8;

/** The prompt that sends `annotations` along with the user's `text`: the filled prompt file, then the text; only the text without annotations. */
export function promptWithAnnotations(annotations: readonly StoredBrowserAnnotation[], text: string): string {
  if (!annotations.length) return text;
  const introduction = fillPrompt(browserAnnotationsPrompt.trim(), { annotations: formatAnnotations(annotations) });
  return text ? `${introduction}\n\n${text}` : introduction;
}

/** `annotations` as numbered Markdown blocks, separated by blank lines. */
export function formatAnnotations(annotations: readonly StoredBrowserAnnotation[]): string {
  return annotations.map((annotation, index) => formatAnnotation(annotation, index + 1)).join("\n\n");
}

/** One annotation as a compact Markdown block headed `### Annotation <number>`. */
export function formatAnnotation(annotation: StoredBrowserAnnotation, number: number): string {
  const facts = [`- Page: ${annotation.title ? `${annotation.title} – ` : ""}${annotation.url}`, `- Element: ${codeSpan(annotation.selector)}`];
  if (annotation.source) {
    facts.push(`- Source: ${codeSpan(sourceLocation(annotation))}`);
  }
  const elementText = collapseWhitespace(annotation.text);
  if (elementText) {
    facts.push(`- Text: ${elementText}`);
  }
  const { rect, viewport } = annotation;
  const [x, y, width, height] = [rect.x, rect.y, rect.width, rect.height].map(Math.round);
  facts.push(`- Box: ${width}×${height} at (${x}, ${y}) in a ${Math.round(viewport.width)}×${Math.round(viewport.height)} viewport`);
  const styles = Object.entries(annotation.styles).slice(0, MAX_LISTED_STYLES);
  if (styles.length) {
    facts.push(`- Styles: ${styles.map(([name, value]) => `${name}: ${value}`).join("; ")}`);
  }
  const parts = [`### Annotation ${number}`, quote(annotation.comment), facts.join("\n")];
  if (annotation.outerHtml.trim()) {
    parts.push(fence(annotation.outerHtml, "html"));
  }
  return parts.join("\n\n");
}

/** Where the annotated element is rendered as `file:line[:column]`; empty without a source. */
export function sourceLocation(annotation: StoredBrowserAnnotation): string {
  const { source } = annotation;
  if (!source) return "";
  return source.column === undefined ? `${source.file}:${source.line}` : `${source.file}:${source.line}:${source.column}`;
}

/** A short name of the annotated element for its chip: the source file's name and line, else its tag and selector's last part. */
export function annotationElementLabel(annotation: StoredBrowserAnnotation): string {
  if (annotation.source) return `${baseName(annotation.source.file)}:${annotation.source.line}`;
  const tag = /^<([a-zA-Z][\w-]*)/.exec(annotation.outerHtml.trim())?.[1]?.toLowerCase();
  const selectorParts = annotation.selector.split(/\s*>\s*|\s+/).filter(Boolean);
  const lastPart = selectorParts[selectorParts.length - 1] ?? annotation.selector;
  if (!tag || lastPart.toLowerCase().startsWith(tag)) return lastPart;
  return `${tag} ${lastPart}`;
}

/** The tooltip of an annotation's chip: its comment, the element's selector and source location, and the page. */
export function annotationTooltip(annotation: StoredBrowserAnnotation): string {
  const page = annotation.title ? `${annotation.title} – ${annotation.url}` : annotation.url;
  return [annotation.comment.trim(), annotation.selector, sourceLocation(annotation), page].filter(Boolean).join("\n");
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** `value` as a Markdown blockquote, line by line. */
function quote(value: string): string {
  return value
    .trim()
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

/** `value` as inline code whose delimiter is longer than any backtick run inside it. */
function codeSpan(value: string): string {
  const delimiter = "`".repeat(longestBacktickRun(value) + 1);
  const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${delimiter}${padding}${value}${padding}${delimiter}`;
}

/** `value` as a fenced code block of `language` whose fence is longer than any backtick run inside it. */
function fence(value: string, language: string): string {
  const delimiter = "`".repeat(Math.max(3, longestBacktickRun(value) + 1));
  return `${delimiter}${language}\n${value.trim()}\n${delimiter}`;
}

function longestBacktickRun(value: string): number {
  return Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
}
