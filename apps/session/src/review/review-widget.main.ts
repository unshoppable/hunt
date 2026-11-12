/**
 * The review widget, which the review server (`review-server.service.ts`) adds to every HTML page of a guarded preview
 * host as `/__hunt/review.js` and the desktop app injects into every page of a local session's Chrome: a floating button
 * starts picking, the element under the pointer is outlined, a click picks it and opens a comment box, which hands
 * the annotation over (`annotation-delivery.utils.ts`). On a preview host "Add" posts it to `/__hunt/review`, from where
 * it reaches the composer of the VM's session in the desktop client. In a Chrome Hunt is attached to, the box asks Hunt
 * through the CDP binding for the sessions of the Chrome's worktree and lists them, below "New sub session", in a
 * dropdown that starts at the session the Chrome belongs to and keeps the last choice; "Send" hands the annotation to
 * the chosen session as a prompt at once, and "Add to session" in the menu of the chevron beside it puts it above that
 * session's composer for the next prompt. Escape cancels picking and closes the box. All of the UI lives in a closed
 * shadow root, so the page's styles and scripts do not reach it; the only globals are the guard against a second copy
 * and the callback Hunt answers the sessions through. `scripts/buildReviewWidget.ts` bundles it for the browser, which
 * runs it on load: as a browser script it has no CLI guard and imports no package and no Node built-in.
 */
import { ANNOTATION_LIMITS, type BrowserAnnotation } from "../../../../libs/domain/src/review/browser-annotation.utils.ts";
import { deliverAnnotation, hasBinding, mountTiming, requestSessions, type AnnotationDelivery, type PostJson, type ReviewSessions } from "./annotation-delivery.utils.ts";
import { angularComponent, attributeSource, cssSelector, pickStyles, reactSource, shorten, shortenHtml, type ElementStep } from "./element-info.utils.ts";

const GUARD = "__huntReviewWidget";
const HOST_TAG = "hunt-review";
const MAX_SOURCE_ANCESTORS = 12;
const TOAST_MS = 2_500;
/** The room in px the menu of the chevron needs below the comment box. */
const MENU_ROOM = 44;
/** The value of the session dropdown's entry for a new sub session. */
const NEW_SESSION = "new";
const CHEVRON_DOWN = `<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 13px; }
.launcher { position: fixed; left: 50%; transform: translateX(-50%); bottom: 16px; z-index: 2147483647; display: flex; align-items: center; gap: 6px; height: 32px;
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
textarea:focus, select:focus { border-color: #2563eb; }
select { width: 100%; height: 28px; padding: 0 6px; border: 1px solid #d1d5db; border-radius: 6px; color: #111827; background: #fff; outline: none; }
.actions { display: flex; justify-content: flex-end; gap: 6px; }
button.action { height: 28px; padding: 0 12px; border-radius: 6px; border: 1px solid #d1d5db; background: #fff; color: #111827; cursor: pointer; }
button.primary { border-color: #2563eb; background: #2563eb; color: #fff; }
button.action:disabled { opacity: 0.5; cursor: default; }
.split { position: relative; display: flex; }
.split [data-send] { border-radius: 6px 0 0 6px; }
.split [data-more] { display: flex; align-items: center; padding: 0 7px; border-radius: 0 6px 6px 0; border-left-color: rgba(255, 255, 255, 0.4); }
.menu { position: absolute; right: 0; top: calc(100% + 4px); min-width: 100%; padding: 4px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2); }
.menu button { display: block; width: 100%; height: 26px; padding: 0 8px; border: 0; border-radius: 4px; background: none; color: #111827; text-align: left;
  white-space: nowrap; cursor: pointer; }
.menu button:hover, .menu button:focus-visible { background: #eff6ff; outline: none; }
[hidden] { display: none !important; }
.error { color: #b91c1c; font-size: 12px; }
.toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: 56px; z-index: 2147483647; padding: 6px 10px; border-radius: 6px; background: #111827; color: #f9fafb;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25); max-width: calc(100vw - 32px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
  /** The sessions Hunt answered last, and the entry of the dropdown the person chose last. */
  let sessions: ReviewSessions | undefined;
  let chosenSession: string | undefined;

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
    // Only a Chrome Hunt is attached to knows the sessions and can send; a preview host adds to the VM's session.
    const isAttached = hasBinding(globals);
    const handOver = isAttached
      ? `<div class="split"><button class="action primary" type="button" data-send>Send</button><button class="action primary" type="button" data-more
  aria-haspopup="menu" aria-expanded="false" title="More ways to hand the comment over">${CHEVRON_DOWN}</button><div class="menu" role="menu" hidden><button
  type="button" role="menuitem" data-add>Add to session</button></div></div>`
      : `<button class="action primary" type="button" data-add>Add</button>`;
    box.innerHTML = `<div class="target"></div>
<select aria-label="The session the comment goes to" hidden></select>
<textarea placeholder="What should the agent change here?"></textarea>
<div class="error" hidden></div>
<div class="actions"><button class="action" type="button" data-cancel>Cancel</button>${handOver}</div>`;
    const target = part<HTMLDivElement>(box, ".target");
    const select = part<HTMLSelectElement>(box, "select");
    const textarea = part<HTMLTextAreaElement>(box, "textarea");
    const error = part<HTMLDivElement>(box, ".error");
    const addButton = part<HTMLButtonElement>(box, "[data-add]");
    const sendButton = box.querySelector<HTMLButtonElement>("[data-send]");
    const moreButton = box.querySelector<HTMLButtonElement>("[data-more]");
    const menu = box.querySelector<HTMLDivElement>(".menu");
    const buttons = [addButton, sendButton, moreButton].filter((button) => button !== null);
    target.textContent = describe(element);
    target.title = target.textContent;
    textarea.maxLength = ANNOTATION_LIMITS.comment;
    let isDelivering = false;
    const enableButtons = () => {
      for (const button of buttons) {
        button.disabled = isDelivering || !textarea.value.trim();
      }
    };
    enableButtons();
    textarea.addEventListener("input", enableButtons);
    part<HTMLButtonElement>(box, "[data-cancel]").addEventListener("click", () => setPhase("idle"));

    const showMenu = (isShown: boolean) => {
      if (!menu || !moreButton) return;
      // The menu opens upwards where the viewport has no room below the box.
      const opensUp = box.getBoundingClientRect().bottom + MENU_ROOM > window.innerHeight;
      Object.assign(menu.style, opensUp ? { top: "auto", bottom: "calc(100% + 4px)" } : { top: "calc(100% + 4px)", bottom: "auto" });
      menu.hidden = !isShown;
      moreButton.setAttribute("aria-expanded", String(isShown));
    };
    moreButton?.addEventListener("click", () => showMenu(Boolean(menu?.hidden)));
    box.addEventListener("click", (event) => {
      if (event.target instanceof Node && !moreButton?.contains(event.target)) {
        showMenu(false);
      }
    });

    /** Lists `known` in the dropdown below "New sub session" and selects the entry chosen last, else the Chrome's session. */
    const listSessions = (known: ReviewSessions) => {
      const entries = [{ value: NEW_SESSION, label: "New sub session" }, ...known.sessions.map((session) => ({ value: session.id, label: `${session.isSub ? "↳ " : ""}${session.title}` }))];
      select.replaceChildren(
        ...entries.map((entry) => {
          const option = document.createElement("option");
          option.value = entry.value;
          option.textContent = entry.label;
          return option;
        }),
      );
      const preferred = [select.hidden ? undefined : select.value, chosenSession, known.own].find((value) => entries.some((entry) => entry.value === value));
      select.value = preferred ?? NEW_SESSION;
      select.hidden = false;
    };
    select.addEventListener("change", () => {
      chosenSession = select.value;
    });
    if (sessions) {
      listSessions(sessions);
    }
    requestSessions(globals, (answered) => {
      sessions = answered;
      if (commentBox === box) {
        listSessions(answered);
      }
    });

    /** Where the annotation goes: the dropdown's session, the Chrome's own while Hunt has not answered the sessions. */
    const deliveryOf = (sends: boolean): AnnotationDelivery | undefined => {
      if (!isAttached) return undefined;
      if (select.hidden) return { isNew: false, sends };
      return select.value === NEW_SESSION ? { isNew: true, sends } : { sessionId: select.value, isNew: false, sends };
    };

    const sessionName = (delivery: AnnotationDelivery): string => {
      if (delivery.isNew) return "a new sub session";
      const title = sessions?.sessions.find((session) => session.id === delivery.sessionId)?.title;
      return title ? `"${shorten(title, 40)}"` : "the session";
    };

    async function handOverComment(sends: boolean): Promise<void> {
      const comment = textarea.value.trim();
      if (!comment || isDelivering) return;
      isDelivering = true;
      enableButtons();
      error.hidden = true;
      const delivery = deliveryOf(sends);
      try {
        await deliverAnnotation(annotationOf(element, comment), delivery, globals, postJson);
        setPhase("idle");
        if (!delivery) {
          toast("Added to the session's next prompt in Hunt");
        } else {
          toast(`${delivery.sends ? "Sent" : "Added"} to ${sessionName(delivery)} in Hunt`);
        }
      } catch (failure) {
        error.textContent = `Could not ${sends ? "send" : "add"} the comment: ${failure instanceof Error ? failure.message : String(failure)}`;
        error.hidden = false;
        isDelivering = false;
        enableButtons();
      }
    }

    addButton.addEventListener("click", () => void handOverComment(false));
    sendButton?.addEventListener("click", () => void handOverComment(true));
    textarea.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      void handOverComment(isAttached);
    });
    shadow.append(box);
    placeBox(box, element.getBoundingClientRect());
    commentBox = box;
    textarea.focus();
  }

  function toast(message: string): void {
    shadow.querySelector(".toast")?.remove();
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

/** A short name of the element for the label and the comment box: tag, id and classes, then its source location or component. */
function describe(element: Element): string {
  const source = sourceOf(element);
  const name = `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${[...element.classList].slice(0, 2).map((className) => `.${className}`).join("")}`;
  if (source) return `${name} · ${source.file.split("/").pop()}:${source.line}`;
  const component = componentOf(element);
  return component ? `${name} · ${component.name}` : name;
}

function componentOf(element: Element): BrowserAnnotation["component"] {
  return angularComponent(element, (window as unknown as { ng?: unknown }).ng);
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
  const component = componentOf(element);
  if (component) {
    annotation.component = component;
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
