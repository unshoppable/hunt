import * as z from "zod/mini";
import { ValueObject } from "../../../../libs/domain/src/model/value-object.model.ts";
import { AGENT_STEPS } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import { ZodGlobPatterns, ZodModelId, ZodSkillName } from "./hunt-json.rules.ts";

const ZodSwfSettingsState = z.object({
  /** The model of Claude Code in a session of the poller; null for Claude Code's default model. */
  model: z._default(z.nullable(ZodModelId), null),
  /** Glob patterns relative to the worktree: a pull request that touches a matching file always needs a human reviewer. */
  humanReviewPaths: z._default(ZodGlobPatterns, () => []),
  /** The skill of every agent step in the order of the steps, as hunt.json names them; Hunt has no default for a step. */
  skills: z.record(z.enum(AGENT_STEPS), ZodSkillName),
});

export interface SwfSettings extends z.infer<typeof ZodSwfSettingsState> {}

/**
 * The `swf` section of hunt.json: the settings of the sessions the gateway's poller starts for the repository's issues.
 * The VM validates them, checks that the worktree holds the skill file of every agent step (`session-config.service.ts`)
 * and reports them to the poller.
 */
export class SwfSettings extends ValueObject<typeof ZodSwfSettingsState> {
  static readonly schema = ZodSwfSettingsState;

  constructor(value: z.input<typeof ZodSwfSettingsState>) {
    super(value);
  }
}
