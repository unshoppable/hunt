import { useEffect, useRef, useState } from "react";
import { commands } from "../ipc/commands";
import type { FileDiff, RemoteChanges } from "../ipc/types";
import { PaneSeparator, Panel, PersistentGroup } from "../layout/ResizablePanes";
import { useSettingsStore } from "../state/settings";
import { useHuntStore } from "../state/store";
import { PRIMARY_BUTTON_XS, SECONDARY_BUTTON_XS } from "../ui/buttons";
import { baseName, dirName } from "../ui/path";
import { errorText, useLoad } from "../ui/useLoad";
import { CodeDiffEditor } from "./CodeDiffEditor";
import { useFileIconUrl } from "./fileIcons";
import { STATUS_NAME_CLASS } from "./styles";

/** Why the remote changes offer no commit, revert, shelve or review comment. */
const READ_ONLY_REASON = "The session runs on its VM, so its changes are read-only here. Bring it back to commit, revert, shelve or comment on them.";

type DiffMode = "split" | "unified";

/** A load of the changes: `version` is bumped by "Refresh" and "Start VM", `startVm` starts a VM that is off. */
type ChangesRequest = { version: number; startVm: boolean };

const ignore = () => {};

/**
 * The changes of a remote session on its VM, read-only: the files changed since its handoff (for a session the swf
 * poller started, since the default branch), committed or not, and the diff of the selected one. Reloads after every
 * turn that ends on the VM and on "Refresh"; a VM that is off starts only on request.
 */
export function RemoteDiffPanel({ sessionId }: { sessionId: string }) {
  const editVersion = useHuntStore((state) => state.chats[sessionId]?.editVersion ?? 0);
  const instance = useHuntStore((state) => state.sessions.find((candidate) => candidate.id === sessionId)?.remote?.vm.instance ?? "");
  const diffFontSize = useSettingsStore((state) => state.panes.diff.fontSize);
  const diffLineHeight = useSettingsStore((state) => state.panes.diff.lineHeight);
  const diffFontFamily = useSettingsStore((state) => state.panes.diff.fontFamily);
  const fileIconUrl = useFileIconUrl();
  const [changes, setChanges] = useState<RemoteChanges | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [request, setRequest] = useState<ChangesRequest>({ version: 0, startVm: false });
  const [mode, setMode] = useState<DiffMode>("split");
  const [isCollapsed, setIsCollapsed] = useState(false);
  const files = changes?.files ?? [];
  const base = changes?.base ?? null;

  // The first list loads at once; reloads after turns wait, so a burst of them loads once.
  const hasLoadedRef = useRef(false);
  useLoad(
    () => {
      hasLoadedRef.current = true;
      setIsLoading(true);
      return commands.remoteChanges(sessionId, request.startVm);
    },
    {
      onValue: (result) => {
        setChanges(result);
        setError(null);
        setIsLoading(false);
      },
      onError: (reason) => {
        setError(errorText(reason));
        setIsLoading(false);
      },
    },
    [sessionId, editVersion, request],
    { delayMs: hasLoadedRef.current ? 300 : 0 },
  );

  // The selection follows the list: a file that left it gives way to the first one.
  useEffect(() => {
    const listed = changes?.files ?? [];
    setSelectedPath((current) => (current && listed.some((file) => file.path === current) ? current : (listed[0]?.path ?? null)));
  }, [changes]);

  // Every reload of the list reloads the diff too, since the file may have changed on the VM.
  useLoad(
    () => commands.readRemoteFileDiff(sessionId, base ?? "", selectedPath ?? ""),
    { onValue: setDiff, onError: (reason) => setError(errorText(reason)) },
    [sessionId, selectedPath, changes],
    { isEnabled: !!selectedPath && !!base },
  );

  const reload = (startVm: boolean) => setRequest((current) => ({ version: current.version + 1, startVm }));
  const shownDiff = diff && diff.path === selectedPath ? diff : null;
  const isVmOff = changes ? !changes.vmRunning : false;

  return (
    <PersistentGroup id="hunt-remote-diff" className="h-full min-h-0">
      <Panel id="files" defaultSize="16%" minSize={140} maxSize={520} className="flex">
        <div className="flex min-w-0 flex-1 flex-col bg-(--changelist-bg)">
          <div className="flex items-center gap-2 border-b border-(--line) px-3 py-2.5 text-[13px] text-neutral-400">
            <span
              className="min-w-0 flex-1 truncate"
              title={base ? `Changes on the VM since ${base.slice(0, 8)}, where the session left its handoff or its default branch` : "Changes on the VM"}
            >
              {changes?.vmRunning ? `${files.length} changed` : "On the VM"}
            </span>
            <button type="button" onClick={() => reload(false)} disabled={isLoading} className={SECONDARY_BUTTON_XS} title="Load the changes on the VM again">
              {isLoading ? "Loading…" : "Refresh"}
            </button>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto py-1 font-(family-name:--changelist-font-family) text-(length:--changelist-font-size) leading-(--changelist-line-height)">
            {files.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => setSelectedPath(file.path)}
                  className={`flex w-full min-w-0 items-center gap-1.5 px-3 text-left hover:bg-(--row-hover) ${selectedPath === file.path ? "bg-(--row-active)" : ""}`}
                  title={`${file.path} (${file.status})`}
                >
                  <img src={fileIconUrl(file.path)} alt="" className="size-[17px] shrink-0" />
                  <span className={`truncate ${STATUS_NAME_CLASS[file.status] ?? "text-neutral-200"}`}>{baseName(file.path)}</span>
                  <span className="ml-auto truncate pl-1 text-[0.85em] text-neutral-600">{dirName(file.path)}</span>
                </button>
              </li>
            ))}
          </ul>
          {/* The local changelist's actions, switched off with their reason: the worktree they would change is on the VM. */}
          <div className="flex items-center gap-2 border-t border-(--line) px-3 py-2.5 text-[13px]" title={READ_ONLY_REASON}>
            <button type="button" disabled className={SECONDARY_BUTTON_XS}>
              Commit…
            </button>
            <button type="button" disabled className={SECONDARY_BUTTON_XS}>
              Shelve…
            </button>
            <button type="button" disabled className={SECONDARY_BUTTON_XS}>
              Revert
            </button>
            <span className="ml-auto truncate text-neutral-500">Read-only</span>
          </div>
        </div>
      </Panel>
      <PaneSeparator />
      <Panel id="viewer" minSize={240} className="flex">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center border-b border-(--line) py-2.5 pr-3 text-[13px]">
            <span className="min-w-0 flex-1 truncate pr-2 pl-3 font-mono text-neutral-300">{selectedPath ?? "No file selected"}</span>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setMode(mode === "split" ? "unified" : "split")} className={SECONDARY_BUTTON_XS}>
                {mode === "split" ? "Split" : "Unified"}
              </button>
              <button
                type="button"
                onClick={() => setIsCollapsed(!isCollapsed)}
                className={SECONDARY_BUTTON_XS}
                title={isCollapsed ? "Show every unchanged line" : "Collapse every unchanged stretch"}
              >
                {isCollapsed ? "Expand all" : "Collapse unchanged"}
              </button>
            </div>
          </div>
          <p className="border-b border-(--line) px-3 py-2 text-[13px] text-neutral-400">{READ_ONLY_REASON}</p>
          {error ? <p className="border-b border-(--line) px-3 py-2 text-[13px] break-words text-red-400">{error}</p> : null}
          <div className="relative min-h-0 flex-1 bg-(--diff-bg)">
            {isVmOff ? (
              <div className="flex flex-col items-start gap-3 p-3 text-[13px] text-neutral-400">
                <p>The VM {instance} is off, so its changes cannot be read. The next prompt starts it, or start it now.</p>
                <button type="button" onClick={() => reload(true)} disabled={isLoading} className={PRIMARY_BUTTON_XS}>
                  {isLoading ? "Starting the VM…" : "Start VM and load changes"}
                </button>
              </div>
            ) : shownDiff ? (
              <CodeDiffEditor
                key={`${sessionId}:${shownDiff.path}`}
                sessionId={sessionId}
                diff={shownDiff}
                mode={mode}
                collapseUnchanged={isCollapsed}
                fontSize={diffFontSize}
                lineHeight={diffLineHeight}
                fontFamily={diffFontFamily}
                readOnly
                isDetached
                onSave={ignore}
                onDirtyChange={ignore}
                onNavigate={ignore}
                onOpenInIde={ignore}
                onOpenSubChat={ignore}
                onToggleSubChat={ignore}
              />
            ) : (
              <p className="p-3 text-[13px] text-neutral-500">
                {!changes ? (isLoading ? "Loading the changes on the VM…" : "") : files.length ? "Loading the diff…" : "No changes on the VM."}
              </p>
            )}
          </div>
        </div>
      </Panel>
    </PersistentGroup>
  );
}
