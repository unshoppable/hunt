import * as z from "zod/mini";
import { ValueObject } from "../model/value-object.model.ts";
import { SessionVmName } from "./session-vm-name.value-object.ts";

/** A session ID: a lowercase UUID, as the desktop and the poller create them. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ZodSessionIdState = z.object({
  id: z.string().check(z.regex(SESSION_ID, "a session ID is a lowercase UUID")),
});

export interface SessionId extends z.infer<typeof ZodSessionIdState> {}

/** The ID of a session and the names derived from it: the short ID and the session VM. */
export class SessionId extends ValueObject<typeof ZodSessionIdState> {
  static readonly schema = ZodSessionIdState;

  constructor(value: z.input<typeof ZodSessionIdState>) {
    super(value);
  }

  static of(id: string): SessionId {
    return new SessionId({ id });
  }

  static isValid(id: string): boolean {
    return SESSION_ID.test(id);
  }

  /** The first 8 hex digits, which name the VM and the preview host. */
  get short(): string {
    return this.id.slice(0, 8);
  }

  get vm(): SessionVmName {
    return new SessionVmName({ short: this.short });
  }
}
