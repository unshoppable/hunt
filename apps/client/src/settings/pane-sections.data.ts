import type { PaneKey, PaneSettings } from "./settings.store";

export type Section = { pane: PaneKey; title: string; hint: string; fields: (keyof PaneSettings)[] };

/** One page per pane; indentation only exists where rows nest. */
export const SECTIONS: Section[] = [
  { pane: "sidebar", title: "Session sidebar", hint: "Session list and sub chats", fields: ["fontFamily", "fontSize", "lineHeight", "indent", "background"] },
  { pane: "chat", title: "Chat", hint: "Messages, tool calls and the prompt", fields: ["fontFamily", "fontSize", "lineHeight", "background"] },
  { pane: "changelist", title: "Changelist", hint: "Changed files and shelves", fields: ["fontFamily", "fontSize", "lineHeight", "indent", "background"] },
  { pane: "diff", title: "Diff pane", hint: "Diff viewer and inline diffs in the chat", fields: ["fontFamily", "fontSize", "lineHeight", "background"] },
  { pane: "git", title: "Git", hint: "Branch tree, commit log and the files of a commit", fields: ["fontFamily", "fontSize", "lineHeight", "indent", "background"] },
  { pane: "editor", title: "Editor", hint: "Code editors of the Editor tab and the editor windows", fields: ["fontFamily", "fontSize", "lineHeight"] },
  { pane: "architecture", title: "Architecture", hint: "Text size the diagrams open with; zooming changes it further", fields: ["fontSize"] },
  { pane: "pullRequest", title: "PR Description", hint: "Description and conversation of the reviewed pull request", fields: ["fontFamily", "fontSize", "lineHeight"] },
  { pane: "preview", title: "Preview", hint: "Services, their state and URLs of a remote session", fields: ["fontSize"] },
  { pane: "terminal", title: "Terminal", hint: "Service logs and shells on the VM of a remote session", fields: ["fontFamily", "fontSize", "lineHeight", "background"] },
];

export const FIELD_LABELS: Record<keyof PaneSettings, { label: string; unit: string }> = {
  fontSize: { label: "Font size", unit: "px" },
  lineHeight: { label: "Line height", unit: "×" },
  indent: { label: "Indent", unit: "px" },
  background: { label: "Background", unit: "" },
  fontFamily: { label: "Font family", unit: "" },
};
