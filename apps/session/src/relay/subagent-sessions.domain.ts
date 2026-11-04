/**
 * The subagent sessions that belong to the relay's session. The adapter announces each child session with a
 * `subagent_spawned` update on its parent session (the relay's own or a child announced before, for a nested subagent)
 * before it sends any update under the child's ID; a resumed generation (`<task>:generation:<n>`) and a child the
 * adapter replays on `session/load` (`<root>:replay-subagent:<toolUseId>`) are announced the same way.
 */
import * as z from "zod/mini";
import { DomainModel } from "../../../../libs/domain/src/model/domain.model.ts";

const ZodSubagentSessionsState = z.object({
  /** The relay's session, the root of every child. */
  rootSessionId: z.string().check(z.minLength(1)),
  /** The child sessions announced so far, nested ones included. */
  childSessionIds: z.set(z.string()),
});

export interface SubagentSessions extends z.infer<typeof ZodSubagentSessionsState> {}

/** The child sessions of the relay's session; see the module comment. */
export class SubagentSessions extends DomainModel<typeof ZodSubagentSessionsState> {
  static readonly schema = ZodSubagentSessionsState;

  constructor(value: z.input<typeof ZodSubagentSessionsState>) {
    super(value);
  }

  /** The sessions of `rootSessionId` before any subagent was announced. */
  static of(rootSessionId: string): SubagentSessions {
    return new SubagentSessions({ rootSessionId, childSessionIds: new Set() });
  }

  /** Whether `sessionId` is the root session or one of its children. */
  owns(sessionId: unknown): boolean {
    return sessionId === this.rootSessionId || this.isChild(sessionId);
  }

  /** Whether `sessionId` is a child session announced so far. */
  isChild(sessionId: unknown): boolean {
    return typeof sessionId === "string" && this.childSessionIds.has(sessionId);
  }

  /** Takes in an update of `sessionId`; a `subagent_spawned` on an owned session makes its child owned too. */
  observe(sessionId: unknown, update: Record<string, unknown>): void {
    if (update.sessionUpdate !== "subagent_spawned" || !this.owns(sessionId)) return;
    const childId = update.subagentSessionId;
    if (typeof childId !== "string" || !childId || this.owns(childId)) return;
    this.changeState(() => {
      this.childSessionIds = new Set([...this.childSessionIds, childId]);
    });
  }
}
