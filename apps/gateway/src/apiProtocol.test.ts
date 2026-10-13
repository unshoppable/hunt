import { describe, expect, it } from "vitest";
import { METHODS } from "../../../libs/domain/src/gatewayApi.ts";
import { ApiError, encodeEvent, errorEvent, isBranchName, isFinalEvent, METHOD_PATTERN, parseEvent, parseRequest } from "./apiProtocol.ts";

const ID = "ab12cd34-0000-4000-8000-000000000001";
const PROVISION = { id: ID, title: "Fix login", repo: "acme/app", branch: "feat/login", machineType: null };

function line(value: unknown): string {
  return JSON.stringify(value);
}

/** The ApiError `parseRequest` throws for `value`. */
function refusal(value: unknown): ApiError {
  try {
    parseRequest(line(value));
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error(`parseRequest accepted ${line(value)}`);
}

describe("parseRequest", () => {
  it("accepts every method of the contract with its params and ignores unknown keys", () => {
    expect(METHODS.every((method) => METHOD_PATTERN.test(method))).toBe(true);
    expect(parseRequest(line({ caller: "jane_doe_example_com", method: "hello" }))).toEqual({ caller: "jane_doe_example_com", method: "hello", params: {} });
    expect(parseRequest(line({ caller: "sa_1234", method: "vms.start", params: { id: ID, extra: true } })).params).toEqual({ id: ID });
    expect(parseRequest(line({ caller: "jane", method: "sessions.provision", params: { ...PROVISION, machineType: "" } })).params).toEqual(PROVISION);
    const applyConfig = { repos: ["acme/app"], maxSessions: 3, machineType: "e2-standard-8" };
    expect(parseRequest(line({ caller: "jane", method: "swf.applyConfig", params: applyConfig })).params).toEqual({
      repos: ["acme/app"],
      maxSessions: 3,
      machineType: "e2-standard-8",
    });
  });

  it("refuses requests without a valid caller or method", () => {
    expect(refusal({ method: "hello" }).code).toBe("forbidden");
    expect(refusal({ caller: "Jane Doe", method: "hello" }).code).toBe("forbidden");
    expect(refusal({ caller: "jane", method: "vms.reboot" })).toMatchObject({
      code: "invalidParams",
      message: expect.stringContaining('unknown method "vms.reboot"'),
    });
    expect(refusal({ caller: "jane", method: "hello; rm -rf /" }).code).toBe("invalidParams");
    expect(() => parseRequest("not json")).toThrow("the request is no JSON object");
  });

  it("validates session IDs, repositories, branches, titles and machine types", () => {
    const provision = (params: Record<string, unknown>) => refusal({ caller: "jane", method: "sessions.provision", params: { ...PROVISION, ...params } }).message;
    expect(refusal({ caller: "jane", method: "vms.get", params: { id: ID.toUpperCase() } }).message).toBe("id must be a session ID (a lowercase UUID)");
    expect(refusal({ caller: "jane", method: "vms.delete", params: [] }).message).toBe("params must be a JSON object");
    expect(provision({ repo: "acme" })).toBe("repo must be <owner>/<repo>");
    expect(provision({ branch: "feat/../x" })).toBe("branch must be a valid Git branch name");
    expect(provision({ title: "x".repeat(301) })).toBe("title must be a line of at most 300 characters");
    expect(provision({ title: "two\nlines" })).toBe("title must be a line of at most 300 characters");
    expect(provision({ machineType: "E2 standard" })).toBe("machineType must be a Compute Engine machine type or null");
    expect(refusal({ caller: "jane", method: "swf.applyConfig", params: { repos: ["acme/app"], maxSessions: 11 } }).message).toBe(
      "maxSessions must be a whole number from 0 to 10",
    );
    expect(refusal({ caller: "jane", method: "swf.applyConfig", params: { repos: "acme/app", maxSessions: 1 } }).message).toBe(
      "repos must be a list of at most 100 <owner>/<repo>",
    );
  });
});

describe("isBranchName", () => {
  it("accepts what git check-ref-format --branch accepts", () => {
    expect(["main", "hunt/12-fix-login", "feat/ä-umlaut", "release-1.2", "a+b@c"].every(isBranchName)).toBe(true);
    const invalid = ["", "-x", "/x", "x/", "x.", "x..y", "x//y", "x.lock", "a/.hidden", "x@{1}", "@", "a b", "a~1", "a^", "a:b", "a?", "a*", "a[b", "a\\b", "a\tb"];
    expect(invalid.filter(isBranchName)).toEqual([]);
    expect(isBranchName("x".repeat(251))).toBe(false);
  });
});

describe("events", () => {
  it("encodes one event per line, reads them back and knows the final ones", () => {
    expect(encodeEvent({ type: "log", message: "two\nlines" })).toBe('{"type":"log","message":"two\\nlines"}\n');
    expect(parseEvent('{"type":"progress","step":"creatingVm"}')).toEqual({ type: "progress", step: "creatingVm" });
    expect(parseEvent('{"type":"other"}')).toBeNull();
    expect(parseEvent("garbage")).toBeNull();
    expect(isFinalEvent({ type: "result", data: {} })).toBe(true);
    expect(isFinalEvent({ type: "error", code: "internal", message: "x" })).toBe(true);
    expect(isFinalEvent({ type: "progress", step: "startingVm" })).toBe(false);
  });

  it("keeps the code of an ApiError and reports anything else as internal", () => {
    expect(errorEvent(new ApiError("conflict", "taken"))).toEqual({ type: "error", code: "conflict", message: "taken" });
    expect(errorEvent(new Error("boom", { cause: new Error("socket hang up") }))).toEqual({ type: "error", code: "internal", message: "boom: socket hang up" });
  });
});
