import { describe, expect, it } from "vitest";
import { createTokenStyleResolver, FontStyle, tokenStyleAttribute, tokenStyleDeclarations } from "./tokenStyle";

const resolve = createTokenStyleResolver([
  { token: "", foreground: "D4D4D4" },
  { token: "keyword", foreground: "569CD6" },
  { token: "", foreground: "#f7e862" },
  { token: "keyword", foreground: "c08cff", fontStyle: "italic" },
  { token: "keyword.json", foreground: "ce9178" },
  { token: "comment", foreground: "808080", fontStyle: "italic" },
  { token: "comment.doc", foreground: "8b929f", fontStyle: "" },
  { token: "comment.doc.tag", fontStyle: "bold italic underline" },
  { token: "member.static", foreground: "ff9b9c", fontStyle: "italic" },
]);

describe("createTokenStyleResolver", () => {
  it("uses the last empty-token rule as default", () => {
    expect(resolve("")).toEqual({ foreground: "#f7e862", fontStyle: FontStyle.None });
    expect(resolve("identifier.ts")).toEqual({ foreground: "#f7e862", fontStyle: FontStyle.None });
  });

  it("lets a later rule override an earlier one for the same token", () => {
    expect(resolve("keyword")).toEqual({ foreground: "#c08cff", fontStyle: FontStyle.Italic });
  });

  it("ignores a language suffix without a specific rule", () => {
    expect(resolve("keyword.ts")).toBe(resolve("keyword"));
    expect(resolve("keyword.json")).toEqual({ foreground: "#ce9178", fontStyle: FontStyle.Italic });
  });

  it("inherits from the parent and clears the font style with an empty string", () => {
    expect(resolve("comment.ts")).toEqual({ foreground: "#808080", fontStyle: FontStyle.Italic });
    expect(resolve("comment.doc.ts")).toEqual({ foreground: "#8b929f", fontStyle: FontStyle.None });
    expect(resolve("comment.doc.tag.ts")).toEqual({ foreground: "#8b929f", fontStyle: FontStyle.Bold | FontStyle.Italic | FontStyle.Underline });
  });

  it("falls back to the parent for an unknown modifier", () => {
    expect(resolve("member.static.declaration")).toEqual({ foreground: "#ff9b9c", fontStyle: FontStyle.Italic });
    expect(resolve("member")).toBe(resolve(""));
  });

  it("shares one object per distinct style", () => {
    expect(resolve("comment.doc.ts")).toBe(resolve("comment.doc"));
  });
});

describe("tokenStyleAttribute", () => {
  it("serializes color and font styles", () => {
    expect(tokenStyleAttribute(resolve("comment.doc.tag"))).toBe("color:#8b929f;font-style:italic;font-weight:bold;text-decoration:underline");
    expect(tokenStyleAttribute(resolve(""))).toBe("color:#f7e862");
  });

  it("caches the declarations per style", () => {
    expect(tokenStyleDeclarations(resolve("keyword"))).toBe(tokenStyleDeclarations(resolve("keyword.ts")));
  });
});
