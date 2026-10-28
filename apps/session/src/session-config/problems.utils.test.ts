import { describe, expect, it } from "vitest";
import * as z from "zod/mini";
import { appendPath, at, parseField, parseOptionalField, Problems, record } from "./problems.utils.ts";

describe("problems", () => {
  it("spell the path of a key, quoting one that is no identifier", () => {
    expect(at("", "services")).toBe("services");
    expect(at("services", "web-ui")).toBe("services.web-ui");
    expect(at("services", "1web")).toBe('services["1web"]');
    expect(at("", "two words")).toBe('["two words"]');
    expect(appendPath("swf", ["humanReviewPaths", 3])).toBe("swf.humanReviewPaths[3]");
    expect(appendPath("services.web", [])).toBe("services.web");
  });

  it("read an object and report its unknown fields before anything else", () => {
    const problems = new Problems();
    expect(record({ command: "x", run: 1 }, "checks.lint", ["command"], problems)).toEqual({ command: "x", run: 1 });
    expect(record({ any: 1 }, "services", null, problems)).toEqual({ any: 1 });
    expect(record([], "services", null, problems)).toBeUndefined();
    expect(problems.messages).toEqual(["checks.lint.run: unknown field", "services: must be an object"]);
  });

  it("report every issue of a rejected field at its path and skip an optional one that is missing", () => {
    const problems = new Problems();
    const schema = z.array(z.string({ error: "must be a string" }));
    expect(parseField(schema, ["a", "b"], "list", problems)).toEqual(["a", "b"]);
    expect(parseField(schema, ["a", 1, null], "list", problems)).toBeUndefined();
    expect(parseOptionalField(schema, undefined, "other", problems)).toBeUndefined();
    expect(problems.messages).toEqual(["list[1]: must be a string", "list[2]: must be a string"]);
  });
});
