import { describe, expect, it } from "vitest";
import { METHODS, type Method } from "../../../../libs/domain/src/gateway-api/gateway-api.types.ts";
import { ApiError } from "../../../../libs/domain/src/gateway-api/api.error.ts";
import { RemoteSecret } from "../../../../libs/domain/src/remote-secrets/remote-secret.value-object.ts";
import { BranchName } from "../../../../libs/domain/src/session/branch-name.value-object.ts";
import { Repository } from "../../../../libs/domain/src/session/repository.value-object.ts";
import { SessionId } from "../../../../libs/domain/src/session/session-id.value-object.ts";
import { encodeEvent, errorEvent, isFinalEvent, METHOD_PATTERN, parseEvent, parseRequest, type ApiParams } from "./gateway-api-protocol.utils.ts";

const ID = "ab12cd34-0000-4000-8000-000000000001";
const PROVISION = { id: ID, title: "Fix login", repo: "acme/app", branch: "feat/login" };
/** PROVISION as `parseRequest` gives it. */
const PROVISIONED = { sessionId: SessionId.of(ID), title: "Fix login", repo: Repository.fromSlug("acme/app"), branch: BranchName.of("feat/login") };

function line(value: unknown): string {
  return JSON.stringify(value);
}

/** The params `parseRequest` gives for a request of `method` with `params`. */
function paramsOf<M extends Method>(method: M, params: unknown): ApiParams[M] {
  return parseRequest(line({ caller: "jane", method, params })).params as ApiParams[M];
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
    expect(parseRequest(line({ caller: "sa_1234", method: "vms.start", params: { id: ID, extra: true } })).params).toEqual({ sessionId: SessionId.of(ID) });
    expect(parseRequest(line({ caller: "jane", method: "sessions.provision", params: { ...PROVISION, machineType: "c4d-standard-8" } })).params).toEqual({
      ...PROVISIONED,
      machineType: "c4d-standard-8",
    });
    for (const params of [PROVISION, { ...PROVISION, machineType: "" }, { ...PROVISION, machineType: null }]) {
      expect(parseRequest(line({ caller: "jane", method: "sessions.provision", params })).params).toEqual({ ...PROVISIONED, machineType: null });
    }
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

  it("validates session IDs, repositories, branches and titles", () => {
    const provision = (params: Record<string, unknown>) => refusal({ caller: "jane", method: "sessions.provision", params: { ...PROVISION, ...params } }).message;
    expect(refusal({ caller: "jane", method: "vms.get", params: { id: ID.toUpperCase() } }).message).toBe("id must be a session ID (a lowercase UUID)");
    expect(refusal({ caller: "jane", method: "vms.delete", params: [] }).message).toBe("params must be a JSON object");
    expect(provision({ repo: "acme" })).toBe("repo must be <owner>/<repo>");
    expect(provision({ branch: "feat/../x" })).toBe("branch must be a valid Git branch name");
    expect(provision({ title: "x".repeat(301) })).toBe("title must be a line of at most 300 characters");
    expect(provision({ title: "two\nlines" })).toBe("title must be a line of at most 300 characters");
    expect(provision({ machineType: "e2-standard-8" })).toMatch(/^machineType must be one of c4d-standard-4, .* or null$/);
    expect(provision({ machineType: 8 })).toMatch(/^machineType must be one of /);
  });

  it("gives the session ID of the VM methods and of a provision as a SessionId", () => {
    for (const method of ["vms.get", "vms.start", "vms.stop", "vms.delete"] as const) {
      const { sessionId } = paramsOf(method, { id: ID });
      expect(sessionId, method).toBeInstanceOf(SessionId);
      expect(sessionId.isEqualTo(SessionId.of(ID)), method).toBe(true);
    }
    const { sessionId } = paramsOf("sessions.provision", PROVISION);
    expect(sessionId).toBeInstanceOf(SessionId);
    expect(sessionId.vm.name).toBe("vm-hunt-s-ab12cd34");
  });

  it("gives the repository of a provision as a Repository", () => {
    const { repo } = paramsOf("sessions.provision", { ...PROVISION, repo: "Acme/my.app" });
    expect(repo).toBeInstanceOf(Repository);
    expect([repo.owner, repo.name, repo.slug]).toEqual(["Acme", "my.app", "Acme/my.app"]);
    expect(refusal({ caller: "jane", method: "sessions.provision", params: { ...PROVISION, repo: "acme/.git" } }).message).toBe("repo must be <owner>/<repo>");
  });

  it("gives the branch of a provision as a BranchName", () => {
    const { branch } = paramsOf("sessions.provision", { ...PROVISION, branch: "fix/general/12-crash" });
    expect(branch).toBeInstanceOf(BranchName);
    expect(branch.name).toBe("fix/general/12-crash");
  });

  it("gives the remote secret of secrets.set as a RemoteSecret and refuses a name or value with the rule it breaks", () => {
    const { secret } = paramsOf("secrets.set", { name: "MED_OPENAI_API_KEY", value: "sk-proj-abcdefgh1234" });
    expect(secret).toBeInstanceOf(RemoteSecret);
    expect(secret.summary()).toEqual({ name: "MED_OPENAI_API_KEY", hint: "1234" });
    expect(paramsOf("secrets.delete", { name: "MED_OPENAI_API_KEY" })).toEqual({ name: "MED_OPENAI_API_KEY" });
    const refusedBecause = (method: Method, params: unknown) => refusal({ caller: "jane", method, params }).message;
    expect(refusedBecause("secrets.set", { name: "lower", value: "sk-proj-x" })).toBe("the name must match ^[A-Z][A-Z0-9_]{0,63}$");
    expect(refusedBecause("secrets.set", { name: "KEY", value: "" })).toBe("the value must be a non-empty string");
    expect(refusedBecause("secrets.set", { name: "KEY", value: "sk-proj\nx" })).toBe("the value must be a single line");
    expect(refusedBecause("secrets.delete", { name: 7 })).toBe("the name must match ^[A-Z][A-Z0-9_]{0,63}$");
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
