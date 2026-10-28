/** Whether `text` has an ASCII control character (below space, or DEL), which no name or title may carry. */
export function hasControlCharacters(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
