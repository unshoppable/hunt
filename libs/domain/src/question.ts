/**
 * Whether a reply of the agent asks the user a question, the same for the desktop's chat and the relay's status: the
 * agent marks a question explicitly (see `libs/domain/prompts/question.system-prompt.md`), and a last paragraph ending
 * with a question mark remains the fallback.
 */

/**
 * `<!-- hunt:question -->` at the very end of a reply, which the agent ends a turn with when it waits for an answer
 * only the user can give; trailing whitespace is allowed.
 */
export const QUESTION_MARKER = /<!--\s*hunt:question\s*-->\s*$/;

/** Markdown and quote characters a question mark may be wrapped in at the end of a paragraph. */
const TRAILING_MARKUP = /[\s*_`~)\]"'»”’]+$/u;

/** Whether the agent marked `text` as a question to the user by ending it with the question marker. */
export function hasQuestionMarker(text: string): boolean {
  return QUESTION_MARKER.test(text);
}

/** Whether the last non-empty paragraph of `text` ends with a question mark, markdown emphasis and quotes aside. */
export function endsWithQuestion(text: string): boolean {
  const paragraphs = text.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const last = paragraphs[paragraphs.length - 1] ?? "";
  return last.replace(TRAILING_MARKUP, "").endsWith("?");
}

/** Whether the agent's reply `text` asks the user a question: it carries the question marker or ends with a question mark. */
export function asksQuestion(text: string): boolean {
  return hasQuestionMarker(text) || endsWithQuestion(text);
}
