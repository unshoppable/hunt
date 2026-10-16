/**
 * `<!-- hunt:question -->` at the very end of a reply, which the agent ends a turn with when it waits for an answer
 * only the user can give (see `libs/domain/prompts/question.system-prompt.md`); trailing whitespace is allowed.
 */
export const QUESTION_MARKER = /<!--\s*hunt:question\s*-->\s*$/;

/** Whether the agent marked `text` as a question to the user by ending it with the question marker. */
export function hasQuestionMarker(text: string): boolean {
  return QUESTION_MARKER.test(text);
}
