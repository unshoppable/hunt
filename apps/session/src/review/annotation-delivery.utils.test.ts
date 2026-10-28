import { describe, expect, it } from "vitest";
import type { BrowserAnnotation } from "../../../../libs/domain/src/review/browser-annotation.utils.ts";
import { deliverAnnotation, mountTiming, REVIEW_BINDING, REVIEW_ENDPOINT, type PostJson } from "./annotation-delivery.utils.ts";

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

    await deliverAnnotation(ANNOTATION, globals, postJson);

    expect(payloads.map((payload) => JSON.parse(payload))).toEqual([ANNOTATION]);
    expect(calls).toEqual([]);
  });

  it("posts the annotation's JSON to the review server without the binding", async () => {
    const { postJson, calls } = recordingPost(204);

    await deliverAnnotation(ANNOTATION, { [REVIEW_BINDING]: "not a function" }, postJson);

    expect(calls).toEqual([[REVIEW_ENDPOINT, JSON.stringify(ANNOTATION)]]);
  });

  it("rejects with the review server's answer, else its status, when it refuses the annotation", async () => {
    await expect(deliverAnnotation(ANNOTATION, {}, recordingPost(400, "comment is empty").postJson)).rejects.toThrow("comment is empty");
    await expect(deliverAnnotation(ANNOTATION, {}, recordingPost(503).postJson)).rejects.toThrow("HTTP 503");
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
