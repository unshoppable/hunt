/**
 * How the review widget (`review-widget.main.ts`) mounts and hands an annotation over, without touching the DOM, so this
 * runs and is tested in Node. On a guarded preview host of a session VM the widget posts to the review server
 * (`review-server.service.ts`); in the Chrome of a local session the desktop app adds the CDP binding `__huntReview` to
 * every page, which takes the annotation straight to Hunt, and injects the widget before the page's document exists.
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

/**
 * Hands the annotation to Hunt: through the CDP binding when `globals` (the page's window) has it, else as a POST to the
 * review server. Rejects with the reason the review server gave when it refused the annotation.
 */
export async function deliverAnnotation(annotation: BrowserAnnotation, globals: Record<string, unknown>, postJson: PostJson): Promise<void> {
  const body = JSON.stringify(annotation);
  const binding = globals[REVIEW_BINDING];
  if (typeof binding === "function") {
    binding.call(globals, body);
    return;
  }
  const response = await postJson(REVIEW_ENDPOINT, body);
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
