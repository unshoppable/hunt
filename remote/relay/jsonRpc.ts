/** JSON-RPC 2.0 message shapes and constructors for both sides of the relay: the adapter's stdio and the client socket. */

export type JsonRpcId = number | string;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: JsonRpcError;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** How a request ended: its result or its error. */
export type Outcome = { result: unknown; error?: undefined } | { result?: undefined; error: JsonRpcError };

/** A received message by kind; `invalid` is everything that is not a single well-formed JSON-RPC message. */
export type IncomingMessage =
  | { kind: "request"; id: JsonRpcId; method: string; params: unknown }
  | { kind: "notification"; message: JsonRpcNotification }
  | { kind: "response"; id: JsonRpcId; outcome: Outcome }
  | { kind: "invalid" };

export const ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  requestCancelled: -32800,
} as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "number" || typeof value === "string";
}

/** Sorts a parsed JSON value into request, notification or response. */
export function classify(value: unknown): IncomingMessage {
  if (!isRecord(value)) return { kind: "invalid" };
  const { id, method, params } = value;
  if (typeof method === "string") {
    if (id === undefined) return { kind: "notification", message: notificationMessage(method, params) };
    return isJsonRpcId(id) ? { kind: "request", id, method, params } : { kind: "invalid" };
  }
  if (!isJsonRpcId(id)) return { kind: "invalid" };
  if (isRecord(value.error)) return { kind: "response", id, outcome: { error: toJsonRpcError(value.error) } };
  if ("result" in value) return { kind: "response", id, outcome: { result: value.result } };
  return { kind: "invalid" };
}

function toJsonRpcError(error: Record<string, unknown>): JsonRpcError {
  const code = typeof error.code === "number" ? error.code : ERROR_CODES.internalError;
  const message = typeof error.message === "string" ? error.message : "Unknown error";
  return "data" in error ? { code, message, data: error.data } : { code, message };
}

export function requestMessage(id: JsonRpcId, method: string, params: unknown): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}

export function notificationMessage(method: string, params: unknown): JsonRpcNotification {
  return { jsonrpc: "2.0", method, params };
}

export function responseMessage(id: JsonRpcId | null, outcome: Outcome): JsonRpcResponse {
  return outcome.error ? { jsonrpc: "2.0", id, error: outcome.error } : { jsonrpc: "2.0", id, result: outcome.result };
}

export function errorOutcome(code: number, message: string, data?: unknown): Outcome {
  return { error: data === undefined ? { code, message } : { code, message, data } };
}
