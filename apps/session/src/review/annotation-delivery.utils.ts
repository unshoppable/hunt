/**
 * How the review widget (`review-widget.main.ts`) mounts and hands an annotation over, without touching the DOM, so this
 * runs and is tested in Node. On a guarded preview host of a session VM the widget posts to the review server
 * (`review-server.service.ts`); in the Chrome of a local session the desktop app adds the CDP binding `__huntReview` to
 * every page, which takes the annotation straight to Hunt, and injects the widget before the page's document exists.
 * Through the binding the widget also asks Hunt for the sessions an annotation can go to and says which one it goes to
 * and whether it is sent at once; the review server knows no sessions, so its annotations go to the composer of the VM's
 * session.
 */
import type { BrowserAnnotation } from "../../../../libs/domain/src/review/browser-annotation.utils.ts";

/** The CDP binding (`Runtime.addBinding`) through which a page of a local session's Chrome reaches Hunt. */
export const REVIEW_BINDING = "__huntReview";
/** The review server's endpoint on a preview host, which takes an annotation as a JSON POST body. */
export const REVIEW_ENDPOINT = "/__hunt/review";

/** The parts of a `fetch` response the widget reads. */
export interface PostResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** Posts `body` as JSON to `url` on the page's own origin. */
export type PostJson = (url: string, body: string) => Promise<PostResponse>;

/** What the widget calls the binding with instead of an annotation to ask for the sessions (see `requestSessions`). */
export const SESSIONS_REQUEST = "sessions";
/** The global of the page Hunt calls with the `ReviewSessions` after a `SESSIONS_REQUEST`. */
export const SESSIONS_CALLBACK = "__huntReviewSessions";

/** A session an annotation can go to: the main session of the Chrome's worktree or one of its sub sessions. */
export interface ReviewSession {
  id: string;
  title: string;
  isSub: boolean;
}

/** The sessions an annotation of this Chrome can go to, the main session first, and the one the Chrome belongs to. */
export interface ReviewSessions {
  sessions: ReviewSession[];
  own: string;
}

/** Where an annotation goes and what happens to it there; only the CDP binding carries it. */
export interface AnnotationDelivery {
  /** The session it goes to; without one, and without `isNew`, the session the Chrome belongs to. */
  sessionId?: string;
  /** It goes to a new sub session of the main session. */
  isNew: boolean;
  /** It is sent as a prompt at once instead of waiting above the composer for the next prompt. */
  sends: boolean;
}

/** Whether the page has the CDP binding, so Hunt answers `requestSessions` and takes an `AnnotationDelivery`. */
export function hasBinding(globals: Record<string, unknown>): boolean {
  return typeof globals[REVIEW_BINDING] === "function";
}

/**
 * Asks Hunt through the CDP binding for the sessions an annotation can go to; `onSessions` gets each answer. Does
 * nothing without the binding.
 */
export function requestSessions(globals: Record<string, unknown>, onSessions: (sessions: ReviewSessions) => void): void {
  const binding = globals[REVIEW_BINDING];
  if (typeof binding !== "function") return;
  globals[SESSIONS_CALLBACK] = (value: unknown) => {
    const sessions = parseReviewSessions(value);
    if (sessions) {
      onSessions(sessions);
    }
  };
  binding.call(globals, SESSIONS_REQUEST);
}

/** `value` as ReviewSessions; undefined when it is none. */
export function parseReviewSessions(value: unknown): ReviewSessions | undefined {
  if (!isObject(value) || typeof value.own !== "string" || !Array.isArray(value.sessions)) return undefined;
  const sessions: ReviewSession[] = [];
  for (const session of value.sessions) {
    if (!isObject(session) || typeof session.id !== "string" || typeof session.title !== "string" || typeof session.isSub !== "boolean") return undefined;
    sessions.push({ id: session.id, title: session.title, isSub: session.isSub });
  }
  return { sessions, own: value.own };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Hands the annotation to Hunt: through the CDP binding when `globals` (the page's window) has it, together with its
 * `delivery`, else as a POST to the review server. Rejects with the reason the review server gave when it refused the
 * annotation.
 */
export async function deliverAnnotation(
  annotation: BrowserAnnotation,
  delivery: AnnotationDelivery | undefined,
  globals: Record<string, unknown>,
  postJson: PostJson,
): Promise<void> {
  const binding = globals[REVIEW_BINDING];
  if (typeof binding === "function") {
    binding.call(globals, JSON.stringify(delivery ? { ...annotation, delivery } : annotation));
    return;
  }
  const response = await postJson(REVIEW_ENDPOINT, JSON.stringify(annotation));
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
}

/** The parts of the document that decide when the widget can mount. */
export interface DocumentState {
  readyState: string;
  hasRoot: boolean;
  hasBody: boolean;
}

/**
 * Whether the widget mounts now, after the parser finished (`DOMContentLoaded`), or never, for a document without a root
 * element. A script injected before the document exists runs while there is no root element or body yet.
 */
export function mountTiming(state: DocumentState): "now" | "afterParsing" | "never" {
  if (state.hasRoot && (state.hasBody || state.readyState !== "loading")) return "now";
  if (state.readyState === "loading") return "afterParsing";
  return "never";
}
