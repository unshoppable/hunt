/**
 * Suppresses the watch events that only echo what the client applied: `apply` records each path's state afterwards,
 * and a later event whose current state equals the recorded one is dropped. The first event with another state is
 * reported and forgets the record.
 */
import * as z from "zod/mini";
import { DomainModel } from "../../../../libs/domain/src/model/domain.model.ts";
import type { FileState } from "./file-state.value-object.ts";

const ZodEchoFilterState = z.object({
  /**
   * The state each change of the client left, by path; null where it deleted the file. The map is checked as a whole:
   * every path the helper applies is recorded, and parsing each entry on every change would make a large apply quadratic.
   */
  applied: z.custom<Map<string, FileState | null>>((value) => value instanceof Map),
});

export interface EchoFilter extends z.infer<typeof ZodEchoFilterState> {}

export class EchoFilter extends DomainModel<typeof ZodEchoFilterState> {
  static readonly schema = ZodEchoFilterState;

  constructor(value: z.input<typeof ZodEchoFilterState>) {
    super(value);
  }

  /** A filter that recorded no change yet. */
  static start(): EchoFilter {
    return new EchoFilter({ applied: new Map() });
  }

  /** Records the state the client's change left at `path`. */
  record(path: string, state: FileState | null): void {
    this.changeState(() => {
      this.applied.set(path, state);
    });
  }

  /** Whether an event at `path` with the current `state` only echoes the recorded change. */
  isEcho(path: string, state: FileState | null): boolean {
    if (!this.applied.has(path)) return false;
    const recorded = this.applied.get(path) ?? null;
    if (recorded ? recorded.isEqualTo(state) : !state) return true;
    this.changeState(() => {
      this.applied.delete(path);
    });
    return false;
  }
}
