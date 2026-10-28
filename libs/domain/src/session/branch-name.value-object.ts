import * as z from "zod/mini";
import { ValueObject } from "../model/value-object.model.ts";
import { hasControlCharacters } from "../shared/text.utils.ts";

const MAX_LENGTH = 250;

/** Whether `name` is a branch name `git check-ref-format --branch` accepts, at most MAX_LENGTH characters. */
function isBranchName(name: string): boolean {
  if (!name || name.length > MAX_LENGTH || hasControlCharacters(name) || /[\s~^:?*[\\]/.test(name)) return false;
  if (name === "@" || name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  return name.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

const ZodBranchNameState = z.object({
  name: z.string().check(z.refine(isBranchName, `a branch name follows git check-ref-format --branch and has at most ${MAX_LENGTH} characters`)),
});

export interface BranchName extends z.infer<typeof ZodBranchNameState> {}

/** The name of a Git branch a session works on. */
export class BranchName extends ValueObject<typeof ZodBranchNameState> {
  static readonly schema = ZodBranchNameState;

  constructor(value: z.input<typeof ZodBranchNameState>) {
    super(value);
  }

  static of(name: string): BranchName {
    return new BranchName({ name });
  }

  static isValid(name: string): boolean {
    return isBranchName(name);
  }
}
