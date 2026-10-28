import type { ErrorCode } from "./gateway-api.types.ts";

/** A failure the gateway API reports with its code; any other error becomes `internal`. */
export class ApiError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}
