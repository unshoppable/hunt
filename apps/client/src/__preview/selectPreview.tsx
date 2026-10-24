import "../index.css";
import * as monaco from "monaco-editor";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { CodeDiffEditor } from "../diff/CodeDiffEditor";
import { useHuntStore } from "../state/store";

const invoked: string[] = [];
let modifiedText = "";
mockIPC((command) => {
  invoked.push(command);
  if (command.startsWith("list") || command.includes("threads")) return [];
  if (command === "read_file") return modifiedText;
  return null;
}, { shouldMockEvents: true });
const editors: monaco.editor.ICodeEditor[] = [];
monaco.editor.onDidCreateEditor((editor) => editors.push(editor));
const original = Array.from({ length: 60 }, (_, index) => `const value${index} = computeSomething(${index}, "text");`).join("\n");
const modified = original.replace("value5 =", "changed5 =").replace("value20 =", "changed20 =");
modifiedText = modified;
useHuntStore.setState({
  sessions: [{ id: "s1", title: "s", parentId: null, worktreePath: "/tmp/hunt-preview-worktree", pullRequest: { number: 1, owner: "o", repo: "r", url: "u", headRef: "h", baseRef: "b" }, reviewComments: [{ id: "d1", path: "a.ts", startLine: 30, line: 30, body: "Draft **text** here", createdAt: "2026-10-23T09:00:00Z", replyTo: null }] } as never],
});
const mode = (new URLSearchParams(location.search).get("mode") ?? "split") as "split" | "unified";
const host = document.getElementById("root")!;
host.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;";
createRoot(host).render(
  <div className="relative min-h-0 flex-1">
    <CodeDiffEditor
      sessionId="s1"
      diff={{ path: "a.ts", oldContent: original, newContent: modified } as never}
      mode={mode}
      collapseUnchanged={false}
      fontSize={13}
      lineHeight={1.6}
      fontFamily="Menlo"
      onSave={() => {}}
      onDirtyChange={() => {}}
      onNavigate={() => {}}
      onOpenInIde={() => {}}
      onOpenUsage={() => {}}
      onError={() => {}}
      onOpenSubChat={() => {}}
      onToggleSubChat={() => {}}
    />
  </div>,
);
Object.assign(window, { __preview: { editors, invoked, monaco } });
