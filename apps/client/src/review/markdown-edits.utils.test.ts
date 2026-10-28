import { describe, expect, it } from "vitest";
import { applyMarkdownAction, type MarkdownAction, type TextSelection } from "./markdown-edits.utils";

/** `|` marks the caret, `[...]` a selection; the text between them is the textarea value. */
function parse(marked: string): TextSelection {
  const caret = marked.indexOf("|");
  if (caret !== -1) return { text: marked.replace("|", ""), selectionStart: caret, selectionEnd: caret };
  const start = marked.indexOf("[");
  const end = marked.indexOf("]") - 1;
  return { text: marked.replace("[", "").replace("]", ""), selectionStart: start, selectionEnd: end };
}

function format({ text, selectionStart, selectionEnd }: TextSelection): string {
  if (selectionStart === selectionEnd) return `${text.slice(0, selectionStart)}|${text.slice(selectionStart)}`;
  return `${text.slice(0, selectionStart)}[${text.slice(selectionStart, selectionEnd)}]${text.slice(selectionEnd)}`;
}

function apply(action: MarkdownAction, marked: string): string {
  return format(applyMarkdownAction(action, parse(marked)));
}

describe("applyMarkdownAction", () => {
  describe("bold", () => {
    it("wraps a selection and keeps it selected", () => {
      expect(apply("bold", "say [hello] there")).toBe("say **[hello]** there");
    });
    it("inserts a pair and puts the caret between without a selection", () => {
      expect(apply("bold", "say |")).toBe("say **|**");
    });
    it("unwraps a selection that is already bold", () => {
      expect(apply("bold", "say **[hello]** there")).toBe("say [hello] there");
      expect(apply("bold", "say [**hello**] there")).toBe("say [hello] there");
    });
  });

  describe("italic", () => {
    it("wraps a selection with underscores", () => {
      expect(apply("italic", "[word]")).toBe("_[word]_");
    });
    it("inserts a pair without a selection", () => {
      expect(apply("italic", "a |b")).toBe("a _|_b");
    });
  });

  describe("code", () => {
    it("wraps a single-line selection in backticks", () => {
      expect(apply("code", "call [foo()] now")).toBe("call `[foo()]` now");
    });
    it("inserts a backtick pair without a selection", () => {
      expect(apply("code", "|")).toBe("`|`");
    });
    it("fences a selection that spans lines", () => {
      expect(apply("code", "[a\nb]")).toBe("```\n[a\nb]\n```");
    });
  });

  describe("link", () => {
    it("links the selection and selects the url placeholder", () => {
      expect(apply("link", "see [docs] here")).toBe("see [docs]([url]) here");
    });
    it("inserts an empty link with the url selected without a selection", () => {
      expect(apply("link", "see |")).toBe("see []([url])");
    });
  });

  describe("heading", () => {
    it("prefixes the caret's line and moves the caret with it", () => {
      expect(apply("heading", "ti|tle")).toBe("### ti|tle");
    });
    it("prefixes every selected line", () => {
      expect(apply("heading", "a\n[b\nc]\nd")).toBe("a\n[### b\n### c]\nd");
    });
    it("removes the prefix when the line already has it", () => {
      expect(apply("heading", "### ti|tle")).toBe("ti|tle");
    });
  });

  describe("quote", () => {
    it("prefixes each selected line", () => {
      expect(apply("quote", "[one\ntwo]")).toBe("[> one\n> two]");
    });
    it("prefixes the caret's line without a selection", () => {
      expect(apply("quote", "one|")).toBe("> one|");
    });
    it("keeps the caret at the line start when removing a prefix in front of it", () => {
      expect(apply("quote", "> |one")).toBe("|one");
    });
  });

  describe("bulletList", () => {
    it("prefixes each selected line", () => {
      expect(apply("bulletList", "[a\nb]")).toBe("[- a\n- b]");
    });
    it("prefixes an empty line at the caret", () => {
      expect(apply("bulletList", "intro\n|")).toBe("intro\n- |");
    });
    it("does not treat a task item as a bullet", () => {
      expect(apply("bulletList", "- [ ] a|")).toBe("- - [ ] a|");
    });
  });

  describe("numberedList", () => {
    it("numbers each selected line from one", () => {
      expect(apply("numberedList", "[a\nb\nc]")).toBe("[1. a\n2. b\n3. c]");
    });
    it("prefixes the caret's line without a selection", () => {
      expect(apply("numberedList", "|a")).toBe("1. |a");
    });
    it("removes the numbers of a numbered selection", () => {
      expect(apply("numberedList", "[1. a\n2. b]")).toBe("[a\nb]");
    });
  });

  describe("taskList", () => {
    it("prefixes each selected line", () => {
      expect(apply("taskList", "[a\nb]")).toBe("[- [ ] a\n- [ ] b]");
    });
    it("prefixes the caret's line without a selection", () => {
      expect(apply("taskList", "a|")).toBe("- [ ] a|");
    });
  });

  describe("mention", () => {
    it("inserts an at sign at the caret", () => {
      expect(apply("mention", "cc |")).toBe("cc @|");
    });
    it("inserts an at sign in front of the selection and keeps it selected", () => {
      expect(apply("mention", "cc [octocat]")).toBe("cc @[octocat]");
    });
  });
});
