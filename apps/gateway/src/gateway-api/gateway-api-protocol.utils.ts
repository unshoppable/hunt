/**
 * The wire format of the gateway API (`libs/domain/src/gateway-api/gateway-api.types.ts`) between the forwarder `gateway-api/gateway-api-forwarder.main.ts` and the
 * server `gateway-api/gateway-api.service.ts`, free of I/O: the request line `{caller, method, params}` the forwarder sends over the Unix socket,
 * the validation of its method and params into value objects, and the NDJSON events that answer it.
 */
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import { METHODS, type ApiEvent, type Method } from "../../../../libs/domain/src/gateway-api/gateway-api.types.ts";
import { encodeLine, parseLine } from "../../../../libs/domain/src/shared/ndjson.utils.ts";
import { ApiError } from "../../../../libs/domain/src/gateway-api/api.error.ts";
import { RemoteSecret } from "../../../../libs/domain/src/remote-secrets/remote-secret.value-object.ts";
import { BranchName } from "../../../../libs/domain/src/session/branch-name.value-object.ts";
import { Repository } from "../../../../libs/domain/src/session/repository.value-object.ts";
import { SessionId } from "../../../../libs/domain/src/session/session-id.value-object.ts";
import { hasControlCharacters } from "../../../../libs/domain/src/shared/text.utils.ts";
import { isSessionMachineType, SESSION_MACHINE_TYPES } from "../../../../libs/domain/src/session/session-machine-type.types.ts";

/** The daemon's Unix socket, in the runtime directory of `hunt-api.service`, which only hunt-gw can open. */
export const SOCKET_PATH = "/run/hunt-api/api.sock";
/** A method name as `hunt-api <method>` passes it; `apps/gateway/vm/hunt-api` checks the same pattern. */
export const METHOD_PATTERN = /^[a-z]+(\.[a-zA-Z]+)?$/;
/** A Linux user name as OS Login creates them, such as `jane_doe_example_com` or `sa_1234567890`. */
const CALLER = /^[a-z_][a-z0-9_.-]{0,99}$/;
export const TITLE_MAX_LENGTH = 300;
/** The longest request line the daemon reads. */
export const MAX_REQUEST_BYTES = 64 * 1024;

/** The params of a method that names a session. */
interface SessionParams {
  sessionId: SessionId;
}

/**
 * The params of each method as `parseParams` gives them: the values of the wire's `request` (`Methods` in
 * `libs/domain/src/gateway-api/gateway-api.types.ts`) as value objects.
 */
export interface ApiParams {
  hello: Record<string, never>;
  "sessions.list": Record<string, never>;
  "vms.get": SessionParams;
  "sessions.provision": SessionParams & { title: string; repo: Repository; branch: BranchName; machineType: string | null };
  "vms.start": SessionParams;
  "vms.stop": SessionParams;
  "vms.delete": SessionParams;
  "secrets.list": Record<string, never>;
  "secrets.set": { secret: RemoteSecret };
  /** A name alone is no remote secret, which always has a value; `RemoteSecret.nameProblem` validates it. */
  "secrets.delete": { name: string };
}

/** A validated request; `method` narrows `params`. */
export type ApiRequest = { [M in Method]: { caller: string; method: M; params: ApiParams[M] } }[Method];

function invalid(message: string): ApiError {
  return new ApiError("invalidParams", message);
}

export function parseMethod(value: unknown): Method {
  if (typeof value !== "string" || !METHOD_PATTERN.test(value) || !(METHODS as readonly string[]).includes(value)) {
    throw invalid(`unknown method ${JSON.stringify(value)}; the gateway serves ${METHODS.join(", ")}`);
  }
  return value as Method;
}

function paramsObject(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw invalid("params must be a JSON object");
  return value as Record<string, unknown>;
}

function sessionId(params: Record<string, unknown>): SessionId {
  const id = params.id;
  if (typeof id !== "string" || !SessionId.isValid(id)) throw invalid("id must be a session ID (a lowercase UUID)");
  return SessionId.of(id);
}

/** The name of a remote secret. */
function secretName(params: Record<string, unknown>): string {
  const problem = RemoteSecret.nameProblem(params.name);
  if (problem) throw invalid(problem);
  return params.name as string;
}

/** The machine type a provision asks for; null keeps the template's. */
function machineType(params: Record<string, unknown>): string | null {
  const value = params.machineType ?? null;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !isSessionMachineType(value)) {
    throw invalid(`machineType must be one of ${SESSION_MACHINE_TYPES.map((type) => type.name).join(", ")} or null`);
  }
  return value;
}

/** The params of `method`, validated into value objects; unknown keys are ignored. */
export function parseParams(method: Method, value: unknown): ApiParams[Method] {
  const params = paramsObject(value);
  switch (method) {
    case "hello":
    case "sessions.list":
    case "secrets.list":
      return {};
    case "vms.get":
    case "vms.start":
    case "vms.stop":
    case "vms.delete":
      return { sessionId: sessionId(params) };
    case "sessions.provision": {
      const { title, repo, branch } = params;
      if (typeof title !== "string" || title.length > TITLE_MAX_LENGTH || hasControlCharacters(title)) {
        throw invalid(`title must be a line of at most ${TITLE_MAX_LENGTH} characters`);
      }
      if (typeof repo !== "string" || !Repository.isSlug(repo)) throw invalid("repo must be <owner>/<repo>");
      if (typeof branch !== "string" || !BranchName.isValid(branch)) throw invalid("branch must be a valid Git branch name");
      return { sessionId: sessionId(params), title, repo: Repository.fromSlug(repo), branch: BranchName.of(branch), machineType: machineType(params) };
    }
    case "secrets.set": {
      const name = secretName(params);
      const problem = RemoteSecret.valueProblem(params.value);
      if (problem) throw invalid(problem);
      return { secret: new RemoteSecret({ name, value: params.value as string }) };
    }
    case "secrets.delete":
      return { name: secretName(params) };
  }
}

/** The request line `{caller, method, params}`; throws an ApiError for anything else. */
export function parseRequest(line: string): ApiRequest {
  const value = parseLine(line);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("the request is no JSON object");
  const { caller, method, params } = value as Record<string, unknown>;
  if (typeof caller !== "string" || !CALLER.test(caller)) throw new ApiError("forbidden", "the request names no valid caller");
  const parsedMethod = parseMethod(method);
  return { caller, method: parsedMethod, params: parseParams(parsedMethod, params) } as ApiRequest;
}

export function encodeEvent(event: ApiEvent): string {
  return encodeLine(event);
}

/** The `error` event of a failure: an ApiError keeps its code, anything else is `internal`. */
export function errorEvent(error: unknown): ApiEvent {
  if (error instanceof ApiError) return { type: "error", code: error.code, message: error.message };
  return { type: "error", code: "internal", message: messageOf(error) };
}

/** The event of one NDJSON line; null for a line that is no event. */
export function parseEvent(line: string): ApiEvent | null {
  const value = parseLine(line) as { type?: unknown } | undefined;
  if (!value || typeof value !== "object") return null;
  switch (value.type) {
    case "progress":
    case "log":
    case "result":
    case "error":
      return value as ApiEvent;
    default:
      return null;
  }
}

/** Whether `event` ends the stream: `result` or `error`. */
export function isFinalEvent(event: ApiEvent): boolean {
  return event.type === "result" || event.type === "error";
}
