import * as z from "zod/mini";

/** An empty, `.` or `..` segment of an absolute path, or a trailing slash. */
const UNNORMALIZED_SEGMENT = /\/(?:\.{1,2})?(?:\/|$)/;

export const PATH_RULE = "must be an absolute path without empty, . or .. segments";
export const POSITION_RULE = "must be a positive integer";
export const FLAG_RULE = "must be true or false";
export const TEXT_RULE = "must be a string";
export const PATHS_RULE = "must be a list of absolute paths";
export const NAMES_RULE = "must be a list of strings";

function isNormalizedAbsolutePath(path: string): boolean {
  return path.startsWith("/") && !UNNORMALIZED_SEGMENT.test(path);
}

/** A file or folder; `hunt-client` resolves every path against the agent's working directory. */
export const ZodAbsolutePath = z.string(PATH_RULE).check(z.refine(isNormalizedAbsolutePath, PATH_RULE));
/** A positive integer: a 1-based line, column or run number. */
export const ZodPositiveInteger = z.int(POSITION_RULE).check(z.positive(POSITION_RULE));
/** Free text: a glob list, a filter text, instructions. */
export const ZodText = z.string(TEXT_RULE);
/** A list of absolute paths. */
export const ZodAbsolutePaths = z.array(ZodAbsolutePath, PATHS_RULE);
/** A list of names or ids. */
export const ZodNames = z.array(z.string(NAMES_RULE), NAMES_RULE);
