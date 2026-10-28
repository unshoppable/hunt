/**
 * The review widget, which the review server (`review-server.service.ts`) adds to every HTML page of a guarded preview
 * host as `/__hunt/review.js` and the desktop app injects into every page of a local session's Chrome: a floating button
 * starts picking, the element under the pointer is outlined, a click picks it and opens a comment box, and "Add" hands
 * the annotation over (`annotation-delivery.utils.ts`: the CDP binding in a local Chrome, else a POST to
 * `/__hunt/review`), from where it reaches the session's composer in the desktop client. Escape cancels picking and
 * closes the box. All of the UI lives in a closed shadow root, so the page's styles and scripts do not reach it; the
 * only global is the guard against a second copy. `scripts/buildReviewWidget.ts` bundles it for the browser, which
 * runs it on load: as a browser script it has no CLI guard and imports no package and no Node built-in.
 */
import { ANNOTATION_LIMITS, type BrowserAnnotation } from "../../../../libs/domain/src/review/browser-annotation.utils.ts";
import { deliverAnnotation, mountTiming, type PostJson } from "./annotation-delivery.utils.ts";
import { attributeSource, cssSelector, pickStyles, reactSource, shorten, shortenHtml, type ElementStep } from "./element-info.utils.ts";

const GUARD = "__huntReviewWidget";
const HOST_TAG = "hunt-review";
const MAX_SOURCE_ANCESTORS = 12;
const TOAST_MS = 2_500;

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 13px; }
.launcher { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; display: flex; align-items: center; gap: 6px; height: 32px;
  padding: 0 12px; border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 16px; background: #1f2937; color: #f9fafb; cursor: pointer;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25); }
.launcher:hover { background: #374151; }
.launcher[data-active] { background: #2563eb; }
.highlight { position: fixed; z-index: 2147483646; pointer-events: none; border: 2px solid #2563eb; border-radius: 3px;
  background: rgba(37, 99, 235, 0.12); display: none; }
.label { position: absolute; left: -2px; top: -22px; padding: 2px 6px; border-radius: 3px; background: #2563eb; color: #fff; font-size: 11px;
  white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
.box { position: fixed; z-index: 2147483647; width: 320px; padding: 10px; border: 1px solid #d1d5db; border-radius: 8px; background: #fff;
  color: #111827; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2); display: flex; flex-direction: column; gap: 8px; }
.target { color: #6b7280; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
textarea { width: 100%; min-height: 72px; resize: vertical; padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 6px; color: #111827;
  background: #fff; outline: none; }
textarea:focus { border-color: #2563eb; }
.actions { display: flex; justify-content: flex-end; gap: 6px; }
button.action { height: 28px; padding: 0 12px; border-radius: 6px; border: 1px solid #d1d5db; background: #fff; color: #111827; cursor: pointer; }
button.primary { border-color: #2563eb; background: #2563eb; color: #fff; }
button.action:disabled { opacity: 0.5; cursor: default; }
.error { color: #b91c1c; font-size: 12px; }
.toast { position: fixed; right: 16px; bottom: 56px; z-index: 2147483647; padding: 6px 10px; border-radius: 6px; background: #111827; color: #f9fafb;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25); }
`;

type Phase = "idle" | "picking" | "commenting";

/** The element of the widget's own markup that `selector` names. */
function part<Part extends Element>(root: ParentNode, selector: string): Part {
  const element = root.querySelector<Part>(selector);
  if (!element) throw new Error(`the review widget has no ${selector}`);
  return element;
}

function start(): void {
  const host = document.createElement(HOST_TAG);
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `<style>${STYLE}</style>
<div class="highlight"><div class="label"></div></div>
<button class="launcher" type="button" title="Pick an element of this page and comment on it for the agent">✎ Review</button>`;
  const highlight = part<HTMLDivElement>(shadow, ".highlight");
  const label = part<HTMLDivElement>(shadow, ".label");
  const launcher = part<HTMLButtonElement>(shadow, ".launcher");
  let phase: Phase = "idle";
  let hovered: Element | null = null;
  let commentBox: HTMLDivElement | null = null;

  const isOwn = (target: EventTarget | null) => target === host;

  function showHighlight(element: Element): void {
    const rect = element.getBoundingClientRect();
    Object.assign(highlight.style, { display: "block", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    label.textContent = describe(element);
    label.style.top = rect.top < 24 ? `${rect.height + 2}px` : "-22px";
  }

  function setPhase(next: Phase): void {
    phase = next;
    launcher.toggleAttribute("data-active", next !== "idle");
    launcher.textContent = next === "idle" ? "✎ Review" : "✕ Cancel";
    if (next === "idle") {
      highlight.style.display = "none";
      hovered = null;
      commentBox?.remove();
      commentBox = null;
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (phase !== "picking") return;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!target || isOwn(target) || target === hovered) return;
    hovered = target;
    showHighlight(target);
  }

  function onClick(event: MouseEvent): void {
    if (phase !== "picking" || isOwn(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    const picked = document.elementFromPoint(event.clientX, event.clientY) ?? hovered;
    if (!picked || isOwn(picked)) return;
    showHighlight(picked);
    openCommentBox(picked);
  }

  /** Keeps the page from acting on the pointer events of picking, which would follow links and press buttons. */
  function swallow(event: Event): void {
    if (phase !== "picking" || isOwn(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (phase === "idle" || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    setPhase("idle");
  }

  function openCommentBox(element: Element): void {
    phase = "commenting";
    commentBox?.remove();
    const box = document.createElement("div");
    box.className = "box";
    box.innerHTML = `<div class="target"></div>
<textarea placeholder="What should the agent change here?"></textarea>
<div class="error" hidden></div>
<div class="actions"><button class="action" type="button" data-cancel>Cancel</button><button class="action primary" type="button" data-add>Add</button></div>`;
    const target = part<HTMLDivElement>(box, ".target");
    const textarea = part<HTMLTextAreaElement>(box, "textarea");
    const error = part<HTMLDivElement>(box, ".error");
    const addButton = part<HTMLButtonElement>(box, "[data-add]");
    target.textContent = describe(element);
    target.title = target.textContent;
    textarea.maxLength = ANNOTATION_LIMITS.comment;
    addButton.disabled = true;
    textarea.addEventListener("input", () => {
      addButton.disabled = !textarea.value.trim();
    });
    part<HTMLButtonElement>(box, "[data-cancel]").addEventListener("click", () => setPhase("idle"));

    async function add(): Promise<void> {
      if (!textarea.value.trim() || addButton.disabled) return;
      addButton.disabled = true;
      error.hidden = true;
      try {
        await deliverAnnotation(annotationOf(element, textarea.value.trim()), globals, postJson);
        setPhase("idle");
        toast("Added to the session's next prompt in Hunt");
      } catch (failure) {
        error.textContent = `Could not add the comment: ${failure instanceof Error ? failure.message : String(failure)}`;
        error.hidden = false;
        addButton.disabled = false;
      }
    }

    addButton.addEventListener("click", () => void add());
    textarea.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      void add();
    });
    shadow.append(box);
    placeBox(box, element.getBoundingClientRect());
    commentBox = box;
    textarea.focus();
  }

  function toast(message: string): void {
    const note = document.createElement("div");
    note.className = "toast";
    note.textContent = message;
    shadow.append(note);
    setTimeout(() => note.remove(), TOAST_MS);
  }

  launcher.addEventListener("click", () => setPhase(phase === "idle" ? "picking" : "idle"));
  // Keys typed into the comment box stay inside the widget, so the page's shortcuts do not fire.
  for (const type of ["keydown", "keyup", "keypress"]) {
    shadow.addEventListener(type, (event) => {
      if ((event as KeyboardEvent).key !== "Escape") {
        event.stopPropagation();
      }
    });
  }
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("click", onClick, true);
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "contextmenu"]) {
    document.addEventListener(type, swallow, true);
  }
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", () => {
    if (phase === "idle" || !hovered) return;
    showHighlight(hovered);
  }, true);
  document.documentElement.append(host);
}

/** Puts the comment box below the element, else above it, within the viewport. */
function placeBox(box: HTMLDivElement, rect: DOMRect): void {
  const margin = 8;
  const width = box.offsetWidth || 320;
  const height = box.offsetHeight || 160;
  const left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin);
  const below = rect.bottom + margin;
  const top = below + height <= window.innerHeight ? below : Math.max(margin, rect.top - height - margin);
  Object.assign(box.style, { left: `${Math.max(margin, left)}px`, top: `${top}px` });
}

/** A short name of the element for the label and the comment box: its source location, else tag, id and classes. */
function describe(element: Element): string {
  const source = sourceOf(element);
  const name = `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${[...element.classList].slice(0, 2).map((className) => `.${className}`).join("")}`;
  if (!source) return name;
  return `${name} · ${source.file.split("/").pop()}:${source.line}`;
}

function sourceOf(element: Element): BrowserAnnotation["source"] {
  let current: Element | null = element;
  for (let depth = 0; current && depth < MAX_SOURCE_ANCESTORS; depth++) {
    const source = reactSource(current) ?? attributeSource((name) => current?.getAttribute(name) ?? null);
    if (source) return source;
    current = current.parentElement;
  }
  return undefined;
}

function chainOf(element: Element): ElementStep[] {
  const chain: ElementStep[] = [];
  for (let current: Element | null = element; current; current = current.parentElement) {
    const tagName = current.tagName;
    const siblings = current.parentElement ? [...current.parentElement.children].filter((sibling) => sibling.tagName === tagName) : [current];
    chain.push({
      tagName: tagName.toLowerCase(),
      id: current.id,
      classNames: [...current.classList],
      indexOfType: siblings.indexOf(current) + 1,
      countOfType: siblings.length,
    });
  }
  return chain;
}

function isUniqueSelector(selector: string): boolean {
  try {
    return document.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

function annotationOf(element: Element, comment: string): BrowserAnnotation {
  const rect = element.getBoundingClientRect();
  const computed = getComputedStyle(element);
  const annotation: BrowserAnnotation = {
    url: shorten(location.href, ANNOTATION_LIMITS.url),
    title: shorten(document.title, ANNOTATION_LIMITS.title),
    selector: shorten(cssSelector(chainOf(element), isUniqueSelector), ANNOTATION_LIMITS.selector),
    text: shorten(element instanceof HTMLElement ? element.innerText : (element.textContent ?? ""), ANNOTATION_LIMITS.text),
    outerHtml: shortenHtml(element.outerHTML),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    styles: pickStyles((property) => computed.getPropertyValue(property)),
    comment: comment.slice(0, ANNOTATION_LIMITS.comment),
  };
  const source = sourceOf(element);
  if (source) {
    annotation.source = source;
  }
  return annotation;
}

const postJson: PostJson = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, credentials: "same-origin" });

const globals = window as unknown as Record<string, unknown>;
if (!globals[GUARD] && window.top === window) {
  globals[GUARD] = true;
  const timing = mountTiming({ readyState: document.readyState, hasRoot: !!document.documentElement, hasBody: !!document.body });
  if (timing === "now") {
    start();
  } else if (timing === "afterParsing") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  }
}
