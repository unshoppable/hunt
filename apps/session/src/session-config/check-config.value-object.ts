import * as z from "zod/mini";
import { ValueObject } from "../../../../libs/domain/src/model/value-object.model.ts";
import { ZodCommandLine, ZodServiceName, ZodWorktreeFolder } from "./hunt-json.rules.ts";

const ZodCheckConfigState = z.object({
  name: ZodServiceName,
  command: ZodCommandLine,
  /** Relative to the worktree; null for the worktree itself. */
  cwd: z._default(z.nullable(ZodWorktreeFolder), null),
});

export interface CheckConfig extends z.infer<typeof ZodCheckConfigState> {}

/**
 * A check of hunt.json, a command such as the linter or the tests: the client's Checks tab runs it in the worktree on
 * the Mac, or on the session VM through `hunt-ctl check`, and shows its output and exit status.
 */
export class CheckConfig extends ValueObject<typeof ZodCheckConfigState> {
  static readonly schema = ZodCheckConfigState;

  constructor(value: z.input<typeof ZodCheckConfigState>) {
    super(value);
  }
}
