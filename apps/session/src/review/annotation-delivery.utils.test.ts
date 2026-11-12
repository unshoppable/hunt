import { describe, expect, it } from "vitest";
import type { BrowserAnnotation } from "../../../../libs/domain/src/review/browser-annotation.utils.ts";
import {
  deliverAnnotation,
  hasBinding,
  mountTiming,
  parseReviewSessions,
  requestSessions,
  REVIEW_BINDING,
  REVIEW_ENDPOINT,
  SESSIONS_CALLBACK,
  SESSIONS_REQUEST,
  type PostJson,
  type ReviewSessions,
} from "./annotation-delivery.utils.ts";

const ANNOTATION: BrowserAnnotation = {
  url: "http://localhost:4200/cart",
  title: "Cart",
  selector: "#checkout",
  text: "Checkout",
  outerHtml: "<button id=\"checkout\">Checkout</button>",
  rect: { x: 10, y: 20, width: 100, height: 32 },
  viewport: { width: 1280, height: 800 },
  styles: { color: "rgb(0, 0, 0)" },
  comment: "Make it green",
};

/** A `PostJson` that records its calls and answers with `status` and `text`. */
function recordingPost(status: number, text = ""): { postJson: PostJson; calls: [string, string][] } {
  const calls: [string, string][] = [];
  const postJson: PostJson = async (url, body) => {
    calls.push([url, body]);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  return { postJson, calls };
}

describe("deliverAnnotation", () => {
  it("calls the CDP binding with the annotation's JSON and sends nothing over the network when the page has it", async () => {
    const payloads: string[] = [];
    const globals: Record<string, unknown> = {};
    globals[REVIEW_BINDING] = function (this: unknown, payload: string) {
      expect(this).toBe(globals);
      payloads.push(payload);
    };
    const { postJson, calls } = recordingPost(204);

    await deliverAnnotation(ANNOTATION, undefined, globals, postJson);

    expect(payloads.map((payload) => JSON.parse(payload))).toEqual([ANNOTATION]);
    expect(calls).toEqual([]);
  });

  it("hands the delivery to the CDP binding with the annotation and leaves it out of a POST to the review server", async () => {
    const payloads: string[] = [];
    const globals: Record<string, unknown> = { [REVIEW_BINDING]: (payload: string) => payloads.push(payload) };
    const delivery = { sessionId: "sub", isNew: false, sends: true };
    const { postJson, calls } = recordingPost(204);

    await deliverAnnotation(ANNOTATION, delivery, globals, postJson);
    await deliverAnnotation(ANNOTATION, delivery, {}, postJson);

    expect(payloads.map((payload) => JSON.parse(payload))).toEqual([{ ...ANNOTATION, delivery }]);
    expect(calls).toEqual([[REVIEW_ENDPOINT, JSON.stringify(ANNOTATION)]]);
  });

  it("posts the annotation's JSON to the review server without the binding", async () => {
    const { postJson, calls } = recordingPost(204);

    await deliverAnnotation(ANNOTATION, undefined, { [REVIEW_BINDING]: "not a function" }, postJson);

    expect(calls).toEqual([[REVIEW_ENDPOINT, JSON.stringify(ANNOTATION)]]);
  });

  it("rejects with the review server's answer, else its status, when it refuses the annotation", async () => {
    await expect(deliverAnnotation(ANNOTATION, undefined, {}, recordingPost(400, "comment is empty").postJson)).rejects.toThrow("comment is empty");
    await expect(deliverAnnotation(ANNOTATION, undefined, {}, recordingPost(503).postJson)).rejects.toThrow("HTTP 503");
  });
});

describe("requestSessions", () => {
  const SESSIONS: ReviewSessions = { sessions: [{ id: "main", title: "Cart", isSub: false }, { id: "sub", title: "Tests", isSub: true }], own: "sub" };

  it("asks through the CDP binding and hands over what Hunt answers through the callback, unless it is malformed", () => {
    const payloads: string[] = [];
    const globals: Record<string, unknown> = { [REVIEW_BINDING]: (payload: string) => payloads.push(payload) };
    const answers: ReviewSessions[] = [];

    expect(hasBinding(globals)).toBe(true);
    requestSessions(globals, (sessions) => answers.push(sessions));
    expect(payloads).toEqual([SESSIONS_REQUEST]);
    const callback = globals[SESSIONS_CALLBACK] as (value: unknown) => void;
    callback({ ...SESSIONS, extra: true });
    callback({ sessions: [{ id: "main" }], own: "main" });
    callback("sessions");

    expect(answers).toEqual([SESSIONS]);
  });

  it("does nothing on a page without the binding", () => {
    const globals: Record<string, unknown> = {};
    requestSessions(globals, () => {
      throw new Error("no answer without a binding");
    });
    expect(hasBinding(globals)).toBe(false);
    expect(SESSIONS_CALLBACK in globals).toBe(false);
    expect(parseReviewSessions({ sessions: "none", own: "main" })).toBeUndefined();
  });
});

describe("mountTiming", () => {
  it("mounts at once into a document that has its body, or whose parsing ended", () => {
    expect(mountTiming({ readyState: "loading", hasRoot: true, hasBody: true })).toBe("now");
    expect(mountTiming({ readyState: "interactive", hasRoot: true, hasBody: true })).toBe("now");
    expect(mountTiming({ readyState: "complete", hasRoot: true, hasBody: false })).toBe("now");
  });

  it("waits for the parser while the document has no root element or body yet, as when injected before the document exists", () => {
    expect(mountTiming({ readyState: "loading", hasRoot: false, hasBody: false })).toBe("afterParsing");
    expect(mountTiming({ readyState: "loading", hasRoot: true, hasBody: false })).toBe("afterParsing");
  });

  it("never mounts into a parsed document without a root element", () => {
    expect(mountTiming({ readyState: "complete", hasRoot: false, hasBody: false })).toBe("never");
  });
});
