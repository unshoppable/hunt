import { describe, expect, it } from "vitest";
import { imageDataUrl, imagePlaceholder, MAX_IMAGE_DATA_LENGTH } from "./image-data.utils";

/** Base64 of the PNG signature. */
const PNG = "iVBORw0KGgo=";

describe("imageDataUrl", () => {
  it("builds a data URL for PNG, JPEG, GIF and WebP in base64", () => {
    for (const mimeType of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(imageDataUrl({ data: PNG, mimeType })).toBe(`data:${mimeType};base64,${PNG}`);
    }
    expect(imageDataUrl({ data: PNG, mimeType: "IMAGE/PNG" })).toBe(`data:image/png;base64,${PNG}`);
  });

  it("rejects every other type, also one that carries more into the URL", () => {
    for (const mimeType of ["image/svg+xml", "text/html", "", " image/png", "image/png;charset=utf-8", "image/png;base64,AAAA#"]) {
      expect(imageDataUrl({ data: PNG, mimeType })).toBeNull();
    }
  });

  it("rejects data that is not padded base64", () => {
    for (const data of ["", "AAA", "AA=A", "A===", "AAA AAA=", "AA-_", 'PHN2Zz4="><script>']) {
      expect(imageDataUrl({ data, mimeType: "image/png" })).toBeNull();
    }
  });

  it("rejects fields that are not strings", () => {
    expect(imageDataUrl({ data: 42, mimeType: "image/png" })).toBeNull();
    expect(imageDataUrl({ data: PNG, mimeType: null })).toBeNull();
    expect(imageDataUrl({})).toBeNull();
  });

  it("shows data up to the length limit and no more", () => {
    expect(imageDataUrl({ data: "A".repeat(MAX_IMAGE_DATA_LENGTH), mimeType: "image/png" })).not.toBeNull();
    expect(imageDataUrl({ data: "A".repeat(MAX_IMAGE_DATA_LENGTH + 4), mimeType: "image/png" })).toBeNull();
  });
});

describe("imagePlaceholder", () => {
  it("names the size of an image over the limit", () => {
    expect(imagePlaceholder({ data: "A".repeat(MAX_IMAGE_DATA_LENGTH + 4), mimeType: "image/png" })).toBe("[image too large to show: 7.5 MB]");
  });

  it("calls every other image it stands in for unsupported", () => {
    expect(imagePlaceholder({ data: PNG, mimeType: "image/svg+xml" })).toBe("[unsupported image]");
    // claude-agent-acp forwards an image the model got by URL with empty data.
    const linkedImage = { data: "", mimeType: "", uri: "https://example.com/a.png" };
    expect(imagePlaceholder(linkedImage)).toBe("[unsupported image]");
  });
});
