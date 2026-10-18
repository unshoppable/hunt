/**
 * Suppresses the watch events that only echo what the client applied: `apply` records each path's state afterwards,
 * and a later event whose current state equals the recorded one is dropped. The first event with another state is
 * reported and forgets the record.
 */
import { sameState, type FileState } from "./protocol.ts";

export class EchoFilter {
  private readonly applied = new Map<string, FileState | null>();

  /** Records the state the client's change left at `path`. */
  record(path: string, state: FileState | null): void {
    this.applied.set(path, state);
  }

  /** Whether an event at `path` with the current `state` only echoes the recorded change. */
  isEcho(path: string, state: FileState | null): boolean {
    if (!this.applied.has(path)) return false;
    if (sameState(this.applied.get(path) ?? null, state)) return true;
    this.applied.delete(path);
    return false;
  }
}
