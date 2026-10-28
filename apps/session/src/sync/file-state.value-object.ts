import type { BigIntStats } from "node:fs";
import * as z from "zod/mini";
import { ValueObject } from "../../../../libs/domain/src/model/value-object.model.ts";

const ZodFileState = z.object({
  /** In bytes; a link's is the length of its target. */
  size: z.int().check(z.nonnegative()),
  /** Nanoseconds since the epoch as a decimal string. */
  modifiedNs: z.string().check(z.regex(/^-?(0|[1-9][0-9]*)$/, "must be a decimal string")),
  /** Whether the owner's execute bit is set. */
  executable: z.boolean(),
  link: z.boolean(),
});

export interface FileState extends z.infer<typeof ZodFileState> {}

/**
 * The state of a file or symbolic link in the worktree as the file sync reports it (`sync-protocol.types.ts`): what its
 * `lstat` says. Two states are the same file when they are equal.
 */
export class FileState extends ValueObject<typeof ZodFileState> {
  static readonly schema = ZodFileState;

  constructor(value: z.input<typeof ZodFileState>) {
    super(value);
  }

  /** The state that `stats`, an `lstat` or `fstat` with bigint times, describes. */
  static fromStats(stats: BigIntStats): FileState {
    return new FileState({
      size: Number(stats.size),
      modifiedNs: stats.mtimeNs.toString(),
      executable: (stats.mode & 0o100n) !== 0n,
      link: stats.isSymbolicLink(),
    });
  }
}
