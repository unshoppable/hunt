import { describe, expect, it } from "vitest";
import type { ToolCallContent } from "@agentclientprotocol/sdk";
import type { ToolCallView } from "../chat.types";
import { describeToolResult } from "./tool-display.utils";

const SCREENSHOT: ToolCallContent = { type: "content", content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" } };
const SCREENSHOT_URL = "data:image/png;base64,iVBORw0KGgo=";

function toolCall(content: ToolCallContent[], status: ToolCallView["status"] = "completed"): ToolCallView {
  return { toolCallId: "toolu_1", title: "browser_take_screenshot", kind: "other", status, content, locations: [] };
}

describe("describeToolResult", () => {
  it("keeps the images of a result out of its text and counts them in the summary", () => {
    const text: ToolCallContent = { type: "content", content: { type: "text", text: "### Result\nTook a screenshot of the current page" } };
    expect(describeToolResult(toolCall([text, SCREENSHOT, SCREENSHOT]))).toMatchObject({
      summary: "2 lines, 2 images",
      text: "### Result\nTook a screenshot of the current page",
      images: [SCREENSHOT_URL, SCREENSHOT_URL],
    });
  });

  it("summarizes a result that is only an image by the image", () => {
    const read = { ...toolCall([SCREENSHOT]), title: "Read logo.png", kind: "read" as const };
    expect(describeToolResult(read)).toMatchObject({ summary: "1 image", text: "", images: [SCREENSHOT_URL] });
  });

  it("shows a placeholder in the text for an image it does not show", () => {
    const svg: ToolCallContent = { type: "content", content: { type: "image", data: "PHN2Zz4=", mimeType: "image/svg+xml" } };
    expect(describeToolResult(toolCall([svg]))).toMatchObject({ summary: "1 line", text: "[unsupported image]", images: [] });
  });

  it("names a failed result an error next to its images", () => {
    expect(describeToolResult(toolCall([SCREENSHOT], "failed"))).toMatchObject({ summary: "Error, 1 image" });
  });
});
