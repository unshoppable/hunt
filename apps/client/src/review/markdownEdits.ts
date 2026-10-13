/**
 * The markdown toolbar of the review comment box as pure edits of a textarea's `{ text, selectionStart, selectionEnd }`:
 * each action returns the new text and the selection to restore, the way GitHub's toolbar behaves.
 */

export type TextSelection = { text: string; selectionStart: number; selectionEnd: number };

export type MarkdownAction = "heading" | "bold" | "italic" | "quote" | "code" | "link" | "bulletList" | "numberedList" | "taskList" | "mention";

export function applyMarkdownAction(action: MarkdownAction, selection: TextSelection): TextSelection {
  switch (action) {
    case "heading":
      return prefixLines(selection, () => "### ", /^### /);
    case "bold":
      return wrap(selection, "**");
    case "italic":
      return wrap(selection, "_");
    case "quote":
      return prefixLines(selection, () => "> ", /^> /);
    case "code":
      return code(selection);
    case "link":
      return link(selection);
    case "bulletList":
      return prefixLines(selection, () => "- ", /^- (?!\[[ x]\] )/);
    case "numberedList":
      return prefixLines(selection, (ordinal) => `${ordinal + 1}. `, /^\d+\. /);
    case "taskList":
      return prefixLines(selection, () => "- [ ] ", /^- \[[ x]\] /);
    case "mention":
      return insertBefore(selection, "@");
  }
}

/**
 * Surrounds the selection with `marker` (and selects the inner text), or removes the markers when the selection is
 * already surrounded by them; without a selection, inserts a pair and puts the caret between them.
 */
function wrap({ text, selectionStart, selectionEnd }: TextSelection, marker: string): TextSelection {
  const before = text.slice(0, selectionStart);
  const selected = text.slice(selectionStart, selectionEnd);
  const after = text.slice(selectionEnd);
  if (before.endsWith(marker) && after.startsWith(marker)) {
    return {
      text: before.slice(0, -marker.length) + selected + after.slice(marker.length),
      selectionStart: selectionStart - marker.length,
      selectionEnd: selectionEnd - marker.length,
    };
  }
  if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= 2 * marker.length) {
    const inner = selected.slice(marker.length, -marker.length);
    return { text: before + inner + after, selectionStart, selectionEnd: selectionStart + inner.length };
  }
  return { text: before + marker + selected + marker + after, selectionStart: selectionStart + marker.length, selectionEnd: selectionEnd + marker.length };
}

/** Inline code around a selection within one line, a fenced block around a selection that spans lines. */
function code(selection: TextSelection): TextSelection {
  const selected = selection.text.slice(selection.selectionStart, selection.selectionEnd);
  if (!selected.includes("\n")) return wrap(selection, "`");
  const { text, selectionStart, selectionEnd } = selection;
  const fenced = `\`\`\`\n${selected}\n\`\`\``;
  return { text: text.slice(0, selectionStart) + fenced + text.slice(selectionEnd), selectionStart: selectionStart + 4, selectionEnd: selectionEnd + 4 };
}

/** `[selection](url)` with the `url` placeholder selected so that typing replaces it; `[](url)` without a selection. */
function link({ text, selectionStart, selectionEnd }: TextSelection): TextSelection {
  const selected = text.slice(selectionStart, selectionEnd);
  const urlStart = selectionStart + 1 + selected.length + 2;
  return { text: `${text.slice(0, selectionStart)}[${selected}](url)${text.slice(selectionEnd)}`, selectionStart: urlStart, selectionEnd: urlStart + 3 };
}

/** Inserts `prefix` in front of the selection and keeps the selected text selected. */
function insertBefore({ text, selectionStart, selectionEnd }: TextSelection, prefix: string): TextSelection {
  const nextText = text.slice(0, selectionStart) + prefix + text.slice(selectionStart);
  return { text: nextText, selectionStart: selectionStart + prefix.length, selectionEnd: selectionEnd + prefix.length };
}

/**
 * Prefixes every line the selection touches with `prefixFor(lineOrdinal)`, or strips the prefixes matching `existing`
 * when every touched line already carries one. A collapsed selection stays a caret, moved with its line's text; a
 * range grows to cover the touched lines in full.
 */
function prefixLines({ text, selectionStart, selectionEnd }: TextSelection, prefixFor: (ordinal: number) => string, existing: RegExp): TextSelection {
  const blockStart = text.lastIndexOf("\n", selectionStart - 1) + 1;
  const lineBreakAfter = text.indexOf("\n", selectionEnd);
  const blockEnd = lineBreakAfter === -1 ? text.length : lineBreakAfter;
  const lines = text.slice(blockStart, blockEnd).split("\n");
  const isPrefixed = lines.every((line) => existing.test(line));
  let caretShift = 0;
  let nextLineStart = blockStart;
  const edited = lines.map((line, ordinal) => {
    const lineStart = nextLineStart;
    nextLineStart += line.length + 1;
    const isCaretLine = selectionStart === selectionEnd && selectionStart >= lineStart && selectionStart <= lineStart + line.length;
    if (isPrefixed) {
      const removed = line.match(existing)?.[0].length ?? 0;
      if (isCaretLine) {
        caretShift = -Math.min(removed, selectionStart - lineStart);
      }
      return line.slice(removed);
    }
    const prefix = prefixFor(ordinal);
    if (isCaretLine) {
      caretShift = prefix.length;
    }
    return prefix + line;
  });
  const block = edited.join("\n");
  const nextText = text.slice(0, blockStart) + block + text.slice(blockEnd);
  if (selectionStart === selectionEnd) {
    return { text: nextText, selectionStart: selectionStart + caretShift, selectionEnd: selectionEnd + caretShift };
  }
  return { text: nextText, selectionStart: blockStart, selectionEnd: blockStart + block.length };
}
