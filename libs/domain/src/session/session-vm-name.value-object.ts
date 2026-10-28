import * as z from "zod/mini";
import { ValueObject } from "../model/value-object.model.ts";
import { ZodSessionShortId } from "./session-id.rules.ts";

const PREFIX = "vm-hunt-s-";
/** The suffix of the VM's name while the gateway moves it to another zone. */
const MOVING_SUFFIX = "-moving";
/** The suffix of the disk snapshot a move goes through. */
const SNAPSHOT_SUFFIX = "-move";
const SESSION_VM = /^vm-hunt-s-([0-9a-f]{8})$/;
/** The first label of a preview host: the short ID, optionally followed by a port. */
const PREVIEW_HOST = /^([0-9a-f]{8})(?:-[0-9]{1,5})?\./;

const ZodSessionVmNameState = z.object({
  short: ZodSessionShortId,
});

export interface SessionVmName extends z.infer<typeof ZodSessionVmNameState> {}

/** The name of a session's VM, `vm-hunt-s-<short>` from the session's short ID, and the names the gateway derives from it. */
export class SessionVmName extends ValueObject<typeof ZodSessionVmNameState> {
  static readonly schema = ZodSessionVmNameState;

  constructor(value: z.input<typeof ZodSessionVmNameState>) {
    super(value);
  }

  /** The session VM `name` names; null for any other VM, including a moving one. */
  static fromName(name: string): SessionVmName | null {
    const short = SESSION_VM.exec(name)?.[1];
    return short ? new SessionVmName({ short }) : null;
  }

  /** The session VM a preview host (`<short>[-<port>].<domain>[:<port>]`, in any case) addresses; null for any other host. */
  static fromPreviewHost(host: string | undefined): SessionVmName | null {
    const short = PREVIEW_HOST.exec((host ?? "").toLowerCase().replace(/:[0-9]+$/, ""))?.[1];
    return short ? new SessionVmName({ short }) : null;
  }

  get name(): string {
    return `${PREFIX}${this.short}`;
  }

  /** The VM's name while the gateway moves it to another zone. */
  get movingName(): string {
    return `${this.name}${MOVING_SUFFIX}`;
  }

  /** The snapshot of the VM's disk a move goes through. */
  get snapshotName(): string {
    return `${this.name}${SNAPSHOT_SUFFIX}`;
  }
}
