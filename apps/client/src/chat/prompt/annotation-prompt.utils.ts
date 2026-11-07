import { fillPrompt } from "../../../../../libs/domain/src/shared/prompts.utils.ts";
import browserAnnotationsPrompt from "../../../prompts/chat/browser-annotations.user-prompt.md?raw";
import type { StoredBrowserAnnotation } from "../../../../../libs/domain/src/review/browser-annotation.utils.ts";
import { baseName } from "../../common/path/path.utils";
import type { Screenshot } from "../chat.types";

/** How many of an annotation's computed styles its Markdown block lists at most. */
const MAX_LISTED_STYLES = 8;
const ANNOTATION_HEADING = /^### Annotation \d+$/;
const IMAGE_REFERENCE = /^\[Image #(\d+)\]$/;

/**
 * The prompt that sends `annotations` along with the user's `text`: the filled prompt file, then the text; only the text
 * without annotations. The screenshots of the annotations (`annotationScreenshots`) are the prompt's images from
 * `firstImageNumber` on, after the images the user attached.
 */
export function promptWithAnnotations(annotations: readonly StoredBrowserAnnotation[], text: string, firstImageNumber = 1): string {
  if (!annotations.length) return text;
  const introduction = fillPrompt(browserAnnotationsPrompt.trim(), { annotations: formatAnnotations(annotations, firstImageNumber) });
  return text ? `${introduction}\n\n${text}` : introduction;
}

/** The screenshots of `annotations` as prompt images, in the order `promptWithAnnotations` numbers them. */
export function annotationScreenshots(annotations: readonly StoredBrowserAnnotation[]): Screenshot[] {
  return annotations.flatMap((annotation) =>
    annotation.screenshotPath ? [{ name: baseName(annotation.screenshotPath), path: annotation.screenshotPath, modifiedAt: annotation.createdAt }] : [],
  );
}

/** `annotations` as numbered Markdown blocks, separated by blank lines; their screenshots are the images from `firstImageNumber` on. */
export function formatAnnotations(annotations: readonly StoredBrowserAnnotation[], firstImageNumber = 1): string {
  let imageNumber = firstImageNumber;
  return annotations
    .map((annotation, index) => formatAnnotation(annotation, index + 1, annotation.screenshotPath ? imageNumber++ : undefined))
    .join("\n\n");
}

/** One annotation as a compact Markdown block headed `### Annotation <number>`; `imageNumber` is the prompt image of its screenshot. */
export function formatAnnotation(annotation: StoredBrowserAnnotation, number: number, imageNumber?: number): string {
  const facts = [`- Page: ${annotation.title ? `${annotation.title} – ` : ""}${annotation.url}`, `- Element: ${codeSpan(annotation.selector)}`];
  if (annotation.source) {
    facts.push(`- Source: ${codeSpan(sourceLocation(annotation))}`);
  }
  if (annotation.component) {
    facts.push(`- Component: ${codeSpan(annotation.component.name)} (${codeSpan(`<${annotation.component.tag}>`)})`);
  }
  if (imageNumber !== undefined) {
    facts.push(`- Screenshot: [Image #${imageNumber}]`);
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

/** An annotation as a sent prompt tells it again (`parseAnnotatedPrompt`), for the chat to show instead of its Markdown block. */
export interface SentAnnotation {
  comment: string;
  /** A short name of the element, as `annotationElementLabel` gives it. */
  label: string;
  /** The page the element is on, as the block names it. */
  page: string;
  /** The prompt image (1-based) of the element's screenshot. */
  imageNumber?: number;
}

/**
 * The annotations and the user's own text of a prompt `promptWithAnnotations` built, so the chat can show those instead
 * of the prompt file; undefined for any other text. It reads the text alone, which is all a reload or the agent's
 * transcript keeps of a prompt.
 */
export function parseAnnotatedPrompt(text: string): { annotations: SentAnnotation[]; text: string } | undefined {
  const introduction = browserAnnotationsPrompt.trim().split("{{annotations}}")[0];
  if (!introduction || !text.startsWith(introduction)) return undefined;
  const lines = text.slice(introduction.length).split("\n");
  const annotations: SentAnnotation[] = [];
  let index = 0;
  const skipBlankLines = () => {
    while (index < lines.length && !lines[index].trim()) index++;
  };
  skipBlankLines();
  while (index < lines.length && ANNOTATION_HEADING.test(lines[index])) {
    index++;
    skipBlankLines();
    const commentLines: string[] = [];
    while (index < lines.length && lines[index].startsWith(">")) {
      commentLines.push(lines[index].replace(/^> ?/, ""));
      index++;
    }
    skipBlankLines();
    const facts = new Map<string, string>();
    while (index < lines.length && lines[index].startsWith("- ")) {
      const fact = /^- ([A-Za-z]+): (.*)$/.exec(lines[index]);
      if (fact) facts.set(fact[1], fact[2]);
      index++;
    }
    let tag: string | undefined;
    const fenceStart = index + 1;
    const delimiter = /^(`{3,})html$/.exec(lines[fenceStart] ?? "")?.[1];
    if (!lines[index]?.trim() && delimiter) {
      const end = lines.indexOf(delimiter, fenceStart + 1);
      if (end < 0) return undefined;
      tag = openingTag(lines[fenceStart + 1] ?? "");
      index = end + 1;
    }
    const comment = commentLines.join("\n").trim();
    const selector = codeSpanContent(facts.get("Element") ?? "");
    if (!comment || !selector) return undefined;
    const source = parseSourceLocation(codeSpanContent(facts.get("Source") ?? ""));
    const component = /^(`+)(.+?)\1/.exec(facts.get("Component") ?? "")?.[2];
    const imageNumber = Number(IMAGE_REFERENCE.exec(facts.get("Screenshot") ?? "")?.[1]);
    annotations.push({
      comment,
      label: elementLabel({ source, component, selector, tag }),
      page: facts.get("Page") ?? "",
      ...(imageNumber > 0 ? { imageNumber } : {}),
    });
    skipBlankLines();
  }
  if (!annotations.length) return undefined;
  return { annotations, text: lines.slice(index).join("\n").trim() };
}

/** A prompt as a short line for a session's title or a queued row: the user's own text, else the first annotation's comment. */
export function promptSummary(text: string): string {
  const parsed = parseAnnotatedPrompt(text);
  if (!parsed) return text;
  return parsed.text || parsed.annotations[0].comment;
}

/** Where the annotated element is rendered as `file:line[:column]`; empty without a source. */
export function sourceLocation(annotation: StoredBrowserAnnotation): string {
  const { source } = annotation;
  if (!source) return "";
  return source.column === undefined ? `${source.file}:${source.line}` : `${source.file}:${source.line}:${source.column}`;
}

/** A short name of the annotated element for its chip: the source file's name and line, else its component, else its tag and selector's last part. */
export function annotationElementLabel(annotation: StoredBrowserAnnotation): string {
  return elementLabel({
    source: annotation.source && { file: annotation.source.file, line: annotation.source.line },
    component: annotation.component?.name,
    selector: annotation.selector,
    tag: openingTag(annotation.outerHtml.trim()),
  });
}

function elementLabel({ source, component, selector, tag }: { source?: { file: string; line: number }; component?: string; selector: string; tag?: string }): string {
  if (source) return `${baseName(source.file)}:${source.line}`;
  if (component) return component;
  const selectorParts = selector.split(/\s*>\s*|\s+/).filter(Boolean);
  const lastPart = selectorParts[selectorParts.length - 1] ?? selector;
  if (!tag || lastPart.toLowerCase().startsWith(tag)) return lastPart;
  return `${tag} ${lastPart}`;
}

/** The lowercase tag name of the element `html` opens with. */
function openingTag(html: string): string | undefined {
  return /^<([a-zA-Z][\w-]*)/.exec(html)?.[1]?.toLowerCase();
}

/** `file:line[:column]` as file and line. */
function parseSourceLocation(location: string): { file: string; line: number } | undefined {
  const match = /^(.+?):(\d+)(?::\d+)?$/.exec(location);
  return match ? { file: match[1], line: Number(match[2]) } : undefined;
}

/** The content of the inline code `value` starts with, as `codeSpan` wrote it. */
function codeSpanContent(value: string): string {
  const match = /^(`+)( ?)(.*?)\2\1$/.exec(value.trim());
  return match ? match[3] : "";
}

/** The tooltip of an annotation's chip: its comment, the element's selector, source location and component, and the page. */
export function annotationTooltip(annotation: StoredBrowserAnnotation): string {
  const page = annotation.title ? `${annotation.title} – ${annotation.url}` : annotation.url;
  return [annotation.comment.trim(), annotation.selector, sourceLocation(annotation), annotation.component?.name ?? "", page].filter(Boolean).join("\n");
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
