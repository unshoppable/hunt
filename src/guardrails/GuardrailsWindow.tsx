import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import * as monaco from "monaco-editor";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useBackendEvents, usePaneStyles, useSettingsSync } from "../app/bootstrap";
import { SubChatPopover, useSubChatPopover } from "../chat/SubChatPopover";
import { EDITOR_APPEARANCE_OPTIONS, MONACO_THEME, setupMonaco } from "../diff/monaco";
import { workspaceFor, type Workspace } from "../ide/documents";
import { useSelectionChats } from "../ide/selectionChats";
import { commands } from "../ipc/commands";
import { useSettingsStore } from "../state/settings";
import { useHuntStore } from "../state/store";
import { HEADER_BAR } from "../ui/bars";
import { BUTTON_SM, DANGER_BUTTON_SM, GHOST_BUTTON_SM, PRIMARY_BUTTON_SM, SECONDARY_BUTTON_SM } from "../ui/buttons";
import { confirmDestructive } from "../ui/confirm";
import { ChevronIcon, InfoIcon, PlusIcon, SparkleIcon, TrashIcon } from "../ui/icons";
import { useSecondaryWindow } from "../ui/nativeWindow";
import { baseName } from "../ui/path";
import { useDismiss } from "../ui/useDismiss";
import { errorText, useLoad } from "../ui/useLoad";
import { creationTask, generationTask, guardrailDeleteTarget, guardrailListRows, guardrailPath, guardrailTemplate, isInsideFolder, KIND_LABELS, kindHelp, listGuardrails, type KindHelp, type Guardrail, type GuardrailKind, type GuardrailListing } from "./guardrails";
import { InstructionTree } from "./InstructionTree";

const KINDS: GuardrailKind[] = ["instruction", "rule", "skill", "agent", "adr"];

/**
 * The repository's guardrails as a window of its own (see guardrailsWindow.ts), opened from the chat header: the
 * `CLAUDE.md` instruction files anywhere in the session's worktree, its rules (`.claude/rules`), skills
 * (`.claude/skills/<name>/SKILL.md`), subagents (`.claude/agents`) and architectural decision records (`docs/adr`),
 * one tab each; the folders are set in the settings (`guardrailDirs`). The help button at the right of the tab bar
 * explains the active tab's kind in a popover. The list on the left (rules grouped by their folders; the instruction
 * files in a tree of the worktree's folders, see InstructionTree.tsx) opens a file in the Markdown editor on the
 * right; "New …" (or the "+" of a folder in the tree) creates one from a template, the trash button of a row or of
 * the editor header deletes one (a skill with its folder) after asking, the trash button of a folder in the tree
 * deletes the folder with everything in it, and a CLAUDE.md dragged onto another folder moves there. "New …" opens
 * a sub chat (see chat/SubChatPopover.tsx) whose agent creates the file under a name it chooses; the file is
 * selected as soon as it appears. "Agent" in the editor header opens a sub chat whose agent writes the open file
 * from the user's instructions; once that sub chat exists, the button shows whether its agent is working and
 * reopens the same chat after the popover was closed. The editor reloads the file after every edit an agent of the
 * worktree finishes. ⌘S or "Save" writes the file; the traffic light, Escape and ⌘W close the window (after asking
 * about unsaved edits). It closes itself once its session was removed.
 */
export function GuardrailsWindow({ sessionId }: { sessionId: string }) {
  const session = useHuntStore((state) => state.sessions.find((candidate) => candidate.id === sessionId) ?? null);
  const refreshSessions = useHuntStore((state) => state.refreshSessions);
  const worktreePath = session?.worktreePath ?? "";
  const noteWorktreeChanged = useHuntStore((state) => state.noteWorktreeChanged);
  const dirs = useSettingsStore((state) => state.guardrailDirs);
  const [isLoaded, setIsLoaded] = useState(false);
  const workspace = workspaceFor(sessionId, worktreePath);
  const [kind, setKind] = useState<GuardrailKind>("instruction");
  const [listing, setListing] = useState<GuardrailListing | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [dirtyPaths, setDirtyPaths] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(new Set());
  const [isHelpShown, setIsHelpShown] = useState(false);
  const helpButtonRef = useRef<HTMLButtonElement>(null);
  const agentChat = useSubChatPopover();
  // Set before the file an agent just created is selected, so that the chat which created it stays open.
  const keepsAgentChat = useRef(false);
  // Every guardrail path of the last listing, to notice a file an agent added.
  const knownPaths = useRef<Set<string> | null>(null);
  // Edits finished by any agent working in this worktree (the session's own or a sub chat's), to reload the open file.
  const editVersion = useHuntStore((state) =>
    state.sessions.filter((candidate) => candidate.worktreePath === worktreePath).reduce((sum, candidate) => sum + (state.chats[candidate.id]?.editVersion ?? 0), 0),
  );

  usePaneStyles();
  useSettingsSync();
  useBackendEvents();

  useEffect(() => {
    void refreshSessions()
      .catch((reason) => setError(errorText(reason)))
      .finally(() => setIsLoaded(true));
  }, [refreshSessions]);

  // The window is pointless once its session is gone (removed together with its worktree).
  const hasSession = !!session;
  useEffect(() => {
    if (!isLoaded || hasSession) return;
    void getCurrentWindow().destroy();
  }, [isLoaded, hasSession]);

  const refresh = useCallback(() => {
    return listGuardrails(sessionId, dirs)
      .then((next) => {
        setListing(next);
        setError(null);
        return next;
      })
      .catch((reason) => {
        setError(String(reason));
        return null;
      });
  }, [sessionId, dirs]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Unsaved edits are marked in the list; the workspace reports every change of a document's dirty state.
  useEffect(() => {
    const subscription = workspace.onDirtyChange((path, isDirty) => {
      setDirtyPaths((current) => (isDirty ? (current.includes(path) ? current : [...current, path]) : current.filter((candidate) => candidate !== path)));
    });
    return () => subscription.dispose();
  }, [workspace]);

  const entries = listing?.[kind] ?? [];
  const selected = entries.find((entry) => entry.path === selectedPath) ?? null;
  // The newest sub chat about the open file, kept across popover closes; the "Agent" button reopens it.
  const fileChat = useSelectionChats(sessionId, selectedPath)[0] ?? null;
  const isFileChatBusy = useHuntStore((state) => (fileChat ? (state.chats[fileChat.sessionId]?.isBusy ?? false) : false));

  // The agent popover is about the open file; another file (or tab) closes it, except the file its agent created.
  const closeAgentChat = agentChat.close;
  useEffect(() => {
    if (keepsAgentChat.current) {
      keepsAgentChat.current = false;
      return;
    }
    closeAgentChat();
  }, [selectedPath, closeAgentChat]);

  /** Whether the open sub chat creates a new file of this tab's kind (its selection names the kind's folder). */
  const isCreationChat = !!listing && kind !== "instruction" && agentChat.shown?.request.selection.path === listing.dirs[kind];

  // A file the creation chat's agent added is selected while that chat stays open.
  useEffect(() => {
    if (!listing) return;
    const paths = new Set(KINDS.flatMap((candidate) => listing[candidate].map((entry) => entry.path)));
    const previous = knownPaths.current;
    knownPaths.current = paths;
    if (!previous || !isCreationChat) return;
    const added = listing[kind].filter((entry) => !previous.has(entry.path));
    if (added.length !== 1) return;
    keepsAgentChat.current = true;
    setSelectedPath(added[0].path);
  }, [listing, kind, isCreationChat]);

  useEffect(() => {
    if (!editVersion) return;
    if (selectedPath) {
      void workspace.reloadFromDisk([selectedPath]);
    }
    void refresh();
    // Runs after an agent's edit only; the open file and the listing are read fresh then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editVersion]);
  const rows = guardrailListRows(entries, collapsedFolders);

  const toggleFolder = (folder: string) => {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(folder)) {
        next.delete(folder);
      } else {
        next.add(folder);
      }
      return next;
    });
  };

  const selectKind = (next: GuardrailKind) => {
    setKind(next);
    setSelectedPath(null);
    setIsHelpShown(false);
    setCollapsedFolders(new Set());
  };

  const requestClose = async () => {
    const dirty = dirtyPaths.filter((path) => KINDS.some((candidate) => listing?.[candidate].some((entry) => entry.path === path)));
    if (!(await workspace.discardIfConfirmed(dirty))) return;
    await getCurrentWindow().destroy();
  };

  useSecondaryWindow("guardrails", requestClose);

  const create = async (title: string) => {
    if (!listing) return;
    const path = guardrailPath(kind, title, listing);
    if (!path) return;
    if (KINDS.some((candidate) => listing[candidate].some((entry) => entry.path === path))) {
      setError(`${path} already exists`);
      return;
    }
    try {
      await commands.writeFile(sessionId, path, guardrailTemplate(kind, title, listing));
    } catch (reason) {
      setError(String(reason));
      return;
    }
    noteWorktreeChanged(sessionId);
    await refresh();
    setSelectedPath(path);
  };

  const remove = async (entry: Guardrail) => {
    const target = guardrailDeleteTarget(entry);
    const question = entry.kind === "skill" ? `Delete the skill "${entry.name}" with its folder ${target}?` : `Delete ${entry.path}?`;
    if (!(await confirmDestructive(question))) return;
    try {
      await commands.deletePath(sessionId, target);
    } catch (reason) {
      setError(String(reason));
      return;
    }
    if (entry.path === selectedPath) {
      setSelectedPath(null);
    }
    workspace.forget(entry.path);
    noteWorktreeChanged(sessionId);
    await refresh();
  };

  /** Deletes a folder of the instruction tree with everything in it, after asking; open files below it are dropped. */
  const removeFolder = async (folder: string) => {
    if (!(await confirmDestructive(`Delete the folder ${folder} with everything in it?`))) return;
    try {
      await commands.deletePath(sessionId, folder);
    } catch (reason) {
      setError(String(reason));
      return;
    }
    if (selectedPath && isInsideFolder(selectedPath, folder)) {
      setSelectedPath(null);
    }
    for (const candidate of KINDS) {
      for (const entry of listing?.[candidate] ?? []) {
        if (!isInsideFolder(entry.path, folder)) continue;
        workspace.forget(entry.path);
      }
    }
    noteWorktreeChanged(sessionId);
    await refresh();
  };

  /** Moves a CLAUDE.md into `folder`; an unsaved one stays where it is until it is saved. */
  const move = async (path: string, folder: string) => {
    if (dirtyPaths.includes(path)) {
      setError(`Save ${path} before moving it`);
      return;
    }
    const target = folder ? `${folder}/CLAUDE.md` : "CLAUDE.md";
    try {
      await commands.movePath(sessionId, path, target);
    } catch (reason) {
      setError(String(reason));
      return;
    }
    workspace.forget(path);
    if (path === selectedPath) {
      setSelectedPath(target);
    }
    noteWorktreeChanged(sessionId);
    await refresh();
  };

  /**
   * Opens the sub chat about `entry`'s file below the "Agent" button: the existing one with its whole conversation,
   * or a new one whose agent sees the file's current content.
   */
  const openAgent = (entry: Guardrail, button: HTMLElement) => {
    const rect = button.getBoundingClientRect();
    const anchor = { x: rect.left, y: rect.bottom + 6 };
    if (fileChat) {
      agentChat.open({ selection: fileChat.selection, anchor }, fileChat.sessionId);
      return;
    }
    const text = workspace.get(entry.path)?.model.getValue() ?? "";
    agentChat.open({ selection: { path: entry.path, startLine: 1, endLine: Math.max(1, text.split("\n").length), text, task: generationTask(entry.kind, entry.path) }, anchor });
  };

  /** Opens the sub chat that creates a new file of this tab's kind below the "New …" button; the agent chooses the name. */
  const openCreateAgent = (button: HTMLElement) => {
    if (!listing || kind === "instruction") return;
    const rect = button.getBoundingClientRect();
    setSelectedPath(null);
    agentChat.open({ selection: { path: listing.dirs[kind], startLine: 1, endLine: 1, text: "", task: creationTask(kind, listing) }, anchor: { x: rect.left, y: rect.bottom + 6 } });
  };

  const save = async (path: string) => {
    try {
      await workspace.save(path);
      setError(null);
      noteWorktreeChanged(sessionId);
    } catch (reason) {
      setError(String(reason));
    }
  };

  const labels = KIND_LABELS[kind];

  if (!session) return null;

  return (
    <div className="flex h-full flex-col bg-(--surface-inspector)">
      {/* The macOS traffic lights sit in this row (see ui/nativeWindow.ts), so it starts further right and drags the window. */}
      <header data-tauri-drag-region="" className={`${HEADER_BAR} gap-2 border-b border-(--line) pr-3 pl-23 text-sm`}>
        <h2 data-tauri-drag-region="" className="shrink-0 font-semibold tracking-wide text-neutral-300">Guardrails</h2>
        <span data-tauri-drag-region="" className="truncate text-neutral-500">{session.title}</span>
      </header>

      {/* The tabs sit in a bar of their own below the title row, like the tab nav of the main window. */}
      <div className="flex shrink-0 items-center gap-3 border-b border-(--line) px-3 py-2.5">
        <div role="tablist" className="flex gap-1">
          {KINDS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={candidate === kind}
              onClick={() => selectKind(candidate)}
              className={`${BUTTON_SM} ${candidate === kind ? "bg-(--row-active) text-white" : "text-neutral-400 hover:bg-(--row-hover) hover:text-white"}`}
            >
              {KIND_LABELS[candidate].plural}
              {listing ? <span className="ml-1 text-[13px] text-neutral-500">{listing[candidate].length}</span> : null}
            </button>
          ))}
        </div>
        <div className="relative ml-auto">
          <button ref={helpButtonRef} type="button" onClick={() => setIsHelpShown((current) => !current)} aria-expanded={isHelpShown} className={GHOST_BUTTON_SM} title={`What ${labels.plural.toLowerCase()} are`}>
            <InfoIcon />
            {labels.plural}
          </button>
          {isHelpShown ? <HelpPopover title={labels.plural} help={kindHelp(kind)} onClose={() => setIsHelpShown(false)} anchorRef={helpButtonRef} /> : null}
        </div>
      </div>

      {error ? <p className="border-b border-(--line) px-4 py-1.5 text-[13px] text-red-400">{error}</p> : null}

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r border-(--line) bg-(--surface-inset)">
          {kind === "instruction" ? (
            listing ? (
              <InstructionTree
                projectName={baseName(worktreePath) || session.title}
                folders={listing.folders}
                instructions={listing.instruction}
                selectedPath={selectedPath}
                dirtyPaths={dirtyPaths}
                onSelect={setSelectedPath}
                onCreate={(folder) => void create(folder)}
                onMove={(path, folder) => void move(path, folder)}
                onDelete={(entry) => void remove(entry)}
                onDeleteFolder={(folder) => void removeFolder(folder)}
              />
            ) : (
              <p className="px-4 py-2 text-[13px] text-neutral-500">{error ? null : "Loading…"}</p>
            )
          ) : (
            <>
              <div className="p-2">
                <button
                  type="button"
                  onClick={(event) => openCreateAgent(event.currentTarget)}
                  className={`${SECONDARY_BUTTON_SM} w-full`}
                  disabled={!listing}
                  title={`Describe ${labels.item} to the agent; it chooses the file name`}
                >
                  <PlusIcon />
                  New {labels.singular}
                </button>
              </div>
              <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 text-[13px]">
                {rows.map((row) =>
                  row.type === "folder" ? (
                    <FolderRow key={`folder:${row.folder}`} name={row.name} depth={row.depth} isExpanded={!collapsedFolders.has(row.folder)} onToggle={() => toggleFolder(row.folder)} />
                  ) : (
                    <GuardrailRow
                      key={row.entry.path}
                      entry={row.entry}
                      depth={row.depth}
                      isSelected={row.entry.path === selectedPath}
                      isDirty={dirtyPaths.includes(row.entry.path)}
                      onSelect={() => setSelectedPath(row.entry.path)}
                      onDelete={() => void remove(row.entry)}
                    />
                  ),
                )}
                {listing && !entries.length ? <li className="px-2 py-2 text-[13px] text-neutral-500">No {labels.plural.toLowerCase()} in this repository yet.</li> : null}
                {!listing && !error ? <li className="px-2 py-2 text-[13px] text-neutral-500">Loading…</li> : null}
              </ul>
            </>
          )}
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          {selected ? (
            <>
              <div className="flex h-10 shrink-0 items-center gap-2 border-b border-(--line) px-3 text-[13px]">
                <span className="min-w-0 flex-1 truncate text-neutral-400" title={`${worktreePath}/${selected.path}`}>
                  {selected.path}
                </span>
                {dirtyPaths.includes(selected.path) ? <span className="text-amber-300">Unsaved</span> : null}
                <button
                  type="button"
                  onClick={(event) => openAgent(selected, event.currentTarget)}
                  className={GHOST_BUTTON_SM}
                  title={fileChat ? "Show the agent's chat about this file" : "Let the agent write this file from your instructions"}
                >
                  <SparkleIcon className={isFileChatBusy ? "size-3.5 animate-pulse" : "size-3.5"} />
                  Agent
                  {isFileChatBusy ? <span className="text-[12px] text-sky-400">working</span> : null}
                </button>
                <button type="button" onClick={() => void remove(selected)} className={DANGER_BUTTON_SM}>
                  <TrashIcon />
                  Delete
                </button>
                <button type="button" onClick={() => void save(selected.path)} disabled={!dirtyPaths.includes(selected.path)} className={PRIMARY_BUTTON_SM} title="⌘S">
                  Save
                </button>
              </div>
              <MarkdownEditor workspace={workspace} path={selected.path} onSave={save} onError={setError} />
            </>
          ) : (
            <p className="flex flex-1 items-center justify-center text-sm text-neutral-500">
              {entries.length ? `Select ${labels.item} to view or edit it.` : kind === "instruction" ? 'Hover a folder in the tree and press "+" to add a CLAUDE.md to it.' : `Create the first one with "New ${labels.singular}".`}
            </p>
          )}
          {agentChat.shown ? (
            <SubChatPopover
              key={agentChat.shown.key}
              parentSessionId={sessionId}
              request={agentChat.shown.request}
              subSessionId={agentChat.shown.subSessionId}
              title={isCreationChat ? `New ${labels.singular}` : `Generate ${agentChat.shown.request.selection.path}`}
              placeholder={isCreationChat ? `What should the new ${labels.singular} be about?` : "What should this file contain?"}
              hasSidebar={false}
              onClose={agentChat.close}
            />
          ) : null}
        </section>
      </div>
    </div>
  );
}

/** Indentation of a list row per folder level, in pixels. */
const ROW_INDENT = 14;

/** Collapsible folder of the list; the rows below it are indented one level further. */
function FolderRow({ name, depth, isExpanded, onToggle }: { name: string; depth: number; isExpanded: boolean; onToggle: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        style={{ paddingLeft: 4 + depth * ROW_INDENT }}
        className="flex w-full items-center gap-1 rounded-md py-1.5 pr-2 text-left text-neutral-400 hover:bg-(--row-hover) hover:text-white"
      >
        <ChevronIcon expanded={isExpanded} className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
      </button>
    </li>
  );
}

/** One guardrail of the list; its delete button shows up while the row is hovered or focused. */
function GuardrailRow({ entry, depth, isSelected, isDirty, onSelect, onDelete }: { entry: Guardrail; depth: number; isSelected: boolean; isDirty: boolean; onSelect: () => void; onDelete: () => void }) {
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onSelect}
        title={entry.path}
        style={{ paddingLeft: 8 + depth * ROW_INDENT }}
        className={`flex w-full items-center gap-2 rounded-md py-1.5 pr-8 text-left ${isSelected ? "bg-(--row-active) text-white" : "text-neutral-300 hover:bg-(--row-hover) hover:text-white"}`}
      >
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {isDirty ? <span className="size-2 shrink-0 rounded-full bg-amber-300" title="Unsaved changes" /> : null}
      </button>
      <button
        type="button"
        onClick={onDelete}
        title={`Delete ${entry.name}`}
        aria-label={`Delete ${entry.name}`}
        className="absolute top-1/2 right-0.5 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-red-400 opacity-0 transition-colors group-hover:opacity-100 hover:bg-red-400/15 hover:text-red-300 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-blue-400/60 outline-none"
      >
        <TrashIcon />
      </button>
    </li>
  );
}

/** Explanation of the active tab's kind, below the help button (`anchorRef`); closes on Escape or a click elsewhere. */
function HelpPopover({ title, help, onClose, anchorRef }: { title: string; help: KindHelp; onClose: () => void; anchorRef: RefObject<HTMLButtonElement | null> }) {
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(rootRef, onClose, { anchorRefs: [anchorRef] });

  return (
    <div ref={rootRef} role="dialog" aria-label={title} className="absolute top-full right-0 z-20 mt-1 w-[30rem] rounded-md border border-neutral-600 bg-(--surface-inset) p-3.5 text-[14px] leading-relaxed text-neutral-200 shadow-lg shadow-black/40">
      <h3 className="mb-1 font-semibold text-neutral-100">{title}</h3>
      <p>{help.what}</p>
      <h4 className="mt-2.5 font-semibold text-neutral-100">How it is loaded</h4>
      <p>{help.loading}</p>
      <h4 className="mt-2.5 font-semibold text-neutral-100">When to use it</h4>
      <p>{help.use}</p>
    </div>
  );
}

/**
 * Title field for a new guardrail (the folder for a CLAUDE.md, empty for the repository root); the resulting path
 * is previewed below while typing. Enter creates, Esc cancels.
 */
/** Monaco editor on the workspace document of `path` with soft wrapping, sized like the editor panes; ⌘S saves. */
function MarkdownEditor({ workspace, path, onSave, onError }: { workspace: Workspace; path: string; onSave: (path: string) => void; onError: (error: string | null) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const fontSize = useSettingsStore((state) => state.panes.diff.fontSize);
  const lineHeight = useSettingsStore((state) => state.panes.diff.lineHeight);
  const fontFamily = useSettingsStore((state) => state.panes.diff.fontFamily);
  const latest = useRef({ workspace, onSave });
  latest.current = { workspace, onSave };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setupMonaco();
    const editor = monaco.editor.create(host, {
      ...EDITOR_APPEARANCE_OPTIONS,
      theme: MONACO_THEME,
      model: null,
      fontSize,
      lineHeight,
      fontFamily,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      overviewRulerBorder: false,
      renderLineHighlight: "line",
      scrollbar: { alwaysConsumeMouseWheel: false },
      wordWrap: "on",
      links: false,
      dragAndDrop: false,
      padding: { top: 12, bottom: 12 },
    });
    editor.addAction({
      id: "hunt.guardrails.save",
      label: "Save file",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => {
        const { workspace: current, onSave: save } = latest.current;
        const shownPath = current.pathOf(editor.getModel()?.uri ?? monaco.Uri.parse("inmemory://none"));
        if (shownPath) {
          save(shownPath);
        }
      },
    });
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
      editor.setModel(null);
      editor.dispose();
    };
    // Created once; the font options follow the settings below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize, lineHeight, fontFamily });
  }, [fontSize, lineHeight, fontFamily]);

  useLoad(
    () => workspace.open(path),
    {
      onValue: (document) => {
        const editor = editorRef.current;
        if (!editor) return;
        editor.setModel(document.model);
        editor.setScrollTop(0);
        editor.focus();
        onError(null);
      },
      onError: (reason) => onError(errorText(reason)),
    },
    [workspace, path, onError],
  );

  return (
    <div className="relative min-h-0 flex-1 bg-(--diff-bg)">
      <div ref={hostRef} className="absolute inset-0" />
    </div>
  );
}
