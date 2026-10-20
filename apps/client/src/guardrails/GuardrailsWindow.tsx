import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as monaco from "monaco-editor";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useBackendEvents, usePaneStyles, useSettingsSync } from "../app/bootstrap";
import { SubChatPopover, useSubChatPopover } from "../chat/SubChatPopover";
import { EDITOR_APPEARANCE_OPTIONS, MONACO_THEME, onShortcut, setupMonaco } from "../diff/monaco";
import { workspaceFor, type Workspace } from "../ide/documents";
import { selectionChatsFor, useSelectionChats, type SelectionChat } from "../ide/selectionChats";
import { commands } from "../ipc/commands";
import { useSettingsStore } from "../state/settings";
import { useHuntStore } from "../state/store";
import { AgentButton } from "../ui/AgentButton";
import { HEADER_BAR } from "../ui/bars";
import { useShortcutLabel } from "../ui/shortcuts";
import { AGENT_GLOW, BUTTON_XS, DANGER_BUTTON_XS, PRIMARY_BUTTON_LG, PRIMARY_BUTTON_XS, SECONDARY_BUTTON_XS } from "../ui/buttons";
import { confirmDestructive } from "../ui/confirm";
import { useHoverAnchor, type HoverAnchor } from "../ui/hoverAnchor";
import { ChevronIcon, PlusIcon, SparkleIcon, TrashIcon } from "../ui/icons";
import { useSecondaryWindow } from "../ui/nativeWindow";
import { baseName } from "../ui/path";
import { useTreeNavigation } from "../ui/useTreeNavigation";
import { errorText, useLoad } from "../ui/useLoad";
import { creationTask, generationTask, GUARDRAIL_CHAT_PATH, guardrailDeleteTarget, guardrailListRows, guardrailPath, guardrailTask, guardrailTemplate, isInsideFolder, KIND_LABELS, kindHelp, listGuardrails, newGuardrailLocation, ownerFolderOf, treeFolders, type Guardrail, type GuardrailKind, type GuardrailListing, type GuardrailLocation } from "./guardrails";
import { GuardrailTree } from "./GuardrailTree";

const KINDS: GuardrailKind[] = ["instruction", "rule", "skill", "agent", "adr"];

/**
 * The repository's guardrails as a window of its own (see guardrailsWindow.ts), opened from the chat header: the
 * `CLAUDE.md` instruction files anywhere in the session's worktree, its rules (`.claude/rules`), skills
 * (`.claude/skills/<name>/SKILL.md`), subagents (`.claude/agents`) and architectural decision records (`docs/adr`),
 * one tab each; the folders are set in the settings (`guardrailDirs`). Rules and skills are also read from the same
 * directory below any folder of the worktree (`src/api/.claude/rules`), which Claude Code loads once it works in
 * that folder. The help button at the right of the tab bar explains the active tab's kind in a popover; "New" at
 * the right of the tab bar opens a sub chat whose agent turns the user's description into the guardrail kind that
 * fits, asking back while that is unclear, and the file it creates opens. The list on the left opens a file in the
 * Markdown editor on the right: instructions, rules and skills in a tree of the worktree's folders (see
 * GuardrailTree.tsx), agents and ADRs as a flat list. In the tree, the "+" of a folder opens the page of a new
 * CLAUDE.md in it or of a new rule or skill in that folder's `.claude` directory, the trash button of a row or of
 * the editor header deletes a file (a skill with its folder) after asking, the trash button of a folder deletes it
 * with everything in it, and a CLAUDE.md or rule dragged onto another folder moves there. The page of a new file
 * ("New …" or "+") shows the kind's template in the editor, with an optional name for all but a CLAUDE.md, and
 * opens its agent chat: "Create" (or ⌘S) writes the template once it was edited (an unedited one is never written,
 * leaving the page drops it), and the sub chat (see chat/SubChatPopover.tsx) lets an agent write the file, under
 * the name or one the agent chooses; the file opens as soon as it appears. "Agent" in the editor header opens a sub chat whose agent writes the open file
 * from the user's instructions; once that sub chat exists, the button shows whether its agent is working and
 * reopens the same chat after the popover was closed. The editor reloads the file after every edit an agent of the
 * worktree finishes. ⌘S or "Save" writes the file; the traffic light, Escape and ⌘W hide the window (after asking
 * about unsaved edits). It closes itself once its session was removed.
 */
export function GuardrailsWindow({ sessionId, isWarm }: { sessionId: string; isWarm: boolean }) {
  const saveShortcut = useShortcutLabel("editor.save");
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
  const helpHover = useHoverAnchor<GuardrailKind>(HELP_OPEN_DELAY);
  const agentChat = useSubChatPopover();
  // The page of a new file of this tab's kind ("New …" or the "+" of a tree folder): where it goes (for a CLAUDE.md
  // `dir` is its folder), its name, and the creation chats that existed before it. Its content starts as the
  // template and follows the name until it is edited; it is written only once edited.
  const [draft, setDraft] = useState<(GuardrailLocation & { name: string; content: string; earlierChats: ReadonlySet<string> }) | null>(null);
  const draftAgentRef = useRef<HTMLButtonElement>(null);
  // The creation chat whose agent wrote a file, per path, so that the file's "Agent" button shows and reopens it.
  const [creatorChats, setCreatorChats] = useState<Record<string, SelectionChat>>({});
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

  // A window booted ahead of time or hidden by its close reads the listing again whenever it is brought back.
  useEffect(() => {
    const subscription = getCurrentWindow().onFocusChanged(({ payload: isFocused }) => {
      if (isFocused) {
        void refresh();
      }
    });
    return () => void subscription.then((unlisten) => unlisten());
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
  const fileChat = useSelectionChats(sessionId, selectedPath)[0] ?? (selectedPath ? creatorChats[selectedPath] : undefined) ?? null;
  const isFileChatBusy = useHuntStore((state) => (fileChat ? (state.chats[fileChat.sessionId]?.isBusy ?? false) : false));
  /** The title the draft's path and template derive from: a CLAUDE.md's folder, otherwise the typed name. */
  const draftTitle = draft ? (kind === "instruction" ? draft.dir : draft.name) : "";
  const draftPath = draft && listing ? guardrailPath(kind, draftTitle, listing, draft) : null;
  const isDraftEdited = !!draft && !!listing && draft.content !== guardrailTemplate(kind, draftTitle, listing);
  /** Whether "Create" may write the draft: the template was edited and, unless it is a CLAUDE.md, a name was typed. */
  const canCreate = isDraftEdited && (kind === "instruction" || !!draft?.name.trim());
  // Sub chats that create the draft's file; their selection names the file (a CLAUDE.md, whose path is fixed) or the directory.
  const draftChatPath = draft ? (kind === "instruction" ? draftPath : draft.dir) : null;
  const creationChats = useSelectionChats(sessionId, draftChatPath);
  const draftChat = draft ? (creationChats.find((chat) => !draft.earlierChats.has(chat.sessionId)) ?? null) : null;
  const isDraftChatBusy = useHuntStore((state) => (draftChat ? (state.chats[draftChat.sessionId]?.isBusy ?? false) : false));

  // The agent popover is about the open file; another file (or tab) closes it, except the file its agent created.
  const closeAgentChat = agentChat.close;
  useEffect(() => {
    if (keepsAgentChat.current) {
      keepsAgentChat.current = false;
      return;
    }
    closeAgentChat();
  }, [selectedPath, closeAgentChat]);

  /** Whether the open sub chat creates a new file of this tab's kind: its selection names one of the kind's directories, or the draft CLAUDE.md. */
  const shownChatPath = agentChat.shown?.request.selection.path;
  const isCreationChat =
    !!listing && !!shownChatPath && (kind === "instruction" ? shownChatPath === draftChatPath : ownerFolderOf(shownChatPath, listing.dirs[kind]) !== null);
  /** Whether the open sub chat is the "New" button's, which creates a guardrail of any kind. */
  const isGuardrailChat = agentChat.shown?.request.selection.path === GUARDRAIL_CHAT_PATH;
  const guardrailChat = useSelectionChats(sessionId, GUARDRAIL_CHAT_PATH)[0] ?? null;

  /** Opens `path` in the editor; the page of a new file closes. */
  const select = (path: string | null) => {
    setDraft(null);
    setSelectedPath(path);
  };

  // A file the creation chat's agent added is selected while that chat stays open; the "New" chat's file may be of any
  // kind, whose tab is shown then.
  useEffect(() => {
    if (!listing) return;
    const paths = new Set(KINDS.flatMap((candidate) => listing[candidate].map((entry) => entry.path)));
    const previous = knownPaths.current;
    knownPaths.current = paths;
    if (!previous || (!isCreationChat && !isGuardrailChat)) return;
    const added = (isGuardrailChat ? KINDS.flatMap((candidate) => listing[candidate]) : listing[kind]).filter((entry) => !previous.has(entry.path));
    if (added.length !== 1) return;
    const { path } = added[0];
    const creator =
      (isGuardrailChat ? guardrailChat : draftChat) ??
      (agentChat.shown?.subSessionId ? { sessionId: agentChat.shown.subSessionId, selection: agentChat.shown.request.selection } : null);
    if (creator) {
      setCreatorChats((current) => ({ ...current, [path]: creator }));
    }
    keepsAgentChat.current = true;
    setDraft(null);
    setKind(added[0].kind);
    setSelectedPath(path);
    // Runs when the listing changes; the chat that wrote the file is read as it is then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing, kind, isCreationChat, isGuardrailChat]);

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

  /** Arrow keys in the list; a folder's key is its path with a trailing slash, a guardrail's its path. */
  const listNav = useTreeNavigation({
    rows: rows.map((row) => (row.type === "folder" ? { key: `${row.folder}/`, depth: row.depth, isExpanded: !collapsedFolders.has(row.folder) } : { key: row.entry.path, depth: row.depth })),
    selectedKey: selectedPath,
    onSelect: select,
    isSelectable: (key) => !key.endsWith("/"),
    onToggle: (key) => toggleFolder(key.slice(0, -1)),
  });

  const selectKind = (next: GuardrailKind) => {
    setKind(next);
    select(null);
    setCollapsedFolders(new Set());
  };

  const requestClose = async () => {
    const dirty = dirtyPaths.filter((path) => KINDS.some((candidate) => listing?.[candidate].some((entry) => entry.path === path)));
    if (!(await workspace.discardIfConfirmed(dirty))) return;
    await getCurrentWindow().hide();
  };

  // A warm window stays hidden until the main window shows it (see openGuardrailsWindow.ts).
  useSecondaryWindow("guardrails", requestClose, { isReady: !isWarm });

  /** Writes a new file named after `title` at `location` with `content`, by default the kind's template, and opens it. */
  const create = async (title: string, content?: string, location: Partial<GuardrailLocation> = {}) => {
    if (!listing) return;
    const path = guardrailPath(kind, title, listing, location);
    if (!path) return;
    if (KINDS.some((candidate) => listing[candidate].some((entry) => entry.path === path))) {
      setError(`${path} already exists`);
      return;
    }
    const template = content ?? guardrailTemplate(kind, title, listing);
    try {
      await commands.writeFile(sessionId, path, template);
    } catch (reason) {
      setError(String(reason));
      return;
    }
    noteWorktreeChanged(sessionId);
    await refresh();
    select(path);
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

  /** Deletes a folder of the tree with everything in it, after asking; open files below it are dropped. */
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

  /** Moves a CLAUDE.md or rule into `folder`; an unsaved one stays where it is until it is saved. */
  const move = async (path: string, folder: string) => {
    if (dirtyPaths.includes(path)) {
      setError(`Save ${path} before moving it`);
      return;
    }
    const target = folder ? `${folder}/${baseName(path)}` : baseName(path);
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

  /**
   * Opens the page of a new file of this tab's kind at `location` (by default the kind's configured directory; for a
   * CLAUDE.md the folder it goes into); its agent chat opens below its "Agent" button once it is shown.
   */
  const openDraft = (location?: GuardrailLocation) => {
    select(null);
    if (!listing) return;
    const target = location ?? { dir: kind === "instruction" ? "" : listing.dirs[kind], folder: "" };
    const title = kind === "instruction" ? target.dir : "";
    const chatPath = kind === "instruction" ? (guardrailPath(kind, title, listing, target) ?? "") : target.dir;
    const earlierChats = new Set(selectionChatsFor(useHuntStore.getState().sessions, sessionId, chatPath).map((chat) => chat.sessionId));
    setDraft({ ...target, name: "", content: guardrailTemplate(kind, title, listing), earlierChats });
  };

  /** Opens the draft's sub chat below `button`: the one already started for this draft, or a new one. */
  const openCreateAgent = (button: HTMLElement) => {
    if (!draft || !listing || !draftChatPath) return;
    const rect = button.getBoundingClientRect();
    const anchor = { x: rect.left, y: rect.bottom + 6 };
    if (draftChat) {
      agentChat.open({ selection: draftChat.selection, anchor }, draftChat.sessionId);
      return;
    }
    agentChat.open({ selection: { path: draftChatPath, startLine: 1, endLine: 1, text: "", task: creationTask(kind, listing, "", draft) }, anchor });
  };

  /** Opens a new "New" chat below `button`, whose agent decides from the user's description which guardrail to create. */
  const openGuardrailAgent = (button: HTMLElement) => {
    if (!listing) return;
    const rect = button.getBoundingClientRect();
    agentChat.open({ selection: { path: GUARDRAIL_CHAT_PATH, startLine: 1, endLine: 1, text: "", task: guardrailTask(listing) }, anchor: { x: rect.left, y: rect.bottom + 6 } });
  };

  // A new draft page starts with its agent chat open.
  const draftEarlierChats = draft?.earlierChats;
  useEffect(() => {
    if (!draftEarlierChats || !draftAgentRef.current) return;
    openCreateAgent(draftAgentRef.current);
    // Runs once per draft; the chat is anchored to the button rendered with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftEarlierChats]);

  /** The open chat's request; a new draft's agent learns the name typed so far when the first question is sent. */
  const shownRequest = agentChat.shown && draft && isCreationChat && !agentChat.shown.subSessionId
    ? { ...agentChat.shown.request, selection: { ...agentChat.shown.request.selection, task: creationTask(kind, listing, draft.name, draft) } }
    : agentChat.shown?.request;

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
              onMouseEnter={(event) => helpHover.enter(candidate, event.currentTarget)}
              onMouseLeave={helpHover.leave}
              className={`${BUTTON_XS} ${candidate === kind ? "bg-(--row-active) text-white" : "text-neutral-400 hover:bg-(--row-hover) hover:text-white"}`}
            >
              {KIND_LABELS[candidate].plural}
              {listing ? <span className="ml-1 text-[13px] text-neutral-500">{listing[candidate].length}</span> : null}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={(event) => openGuardrailAgent(event.currentTarget)}
          disabled={!listing}
          className={`${PRIMARY_BUTTON_LG} ${AGENT_GLOW} ml-auto`}
          title="Describe a guardrail and let the agent create it as the fitting kind"
        >
          <SparkleIcon />
          New
        </button>
      </div>
      {helpHover.anchor ? <HelpTooltip anchor={helpHover.anchor} onEnter={helpHover.keep} onLeave={helpHover.leave} /> : null}

      {error ? <p className="border-b border-(--line) px-4 py-1.5 text-[13px] text-red-400">{error}</p> : null}

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r border-(--line) bg-(--surface-inset)">
          {kind !== "instruction" ? (
            <div className="p-2">
              <button type="button" onClick={() => openDraft()} className={`${SECONDARY_BUTTON_XS} w-full`} disabled={!listing} title={`Open the page of a new ${labels.singular}`}>
                <PlusIcon />
                New {labels.singular}
              </button>
            </div>
          ) : null}
          {kind === "instruction" || kind === "rule" || kind === "skill" ? (
            listing ? (
              <GuardrailTree
                key={kind}
                kind={kind}
                projectName={baseName(worktreePath) || session.title}
                folders={treeFolders(kind, listing)}
                kindDirs={kind === "instruction" ? [] : listing.foundDirs[kind]}
                entries={entries}
                selectedPath={selectedPath}
                dirtyPaths={dirtyPaths}
                onSelect={select}
                onCreate={(folder) => openDraft(kind === "instruction" ? { dir: folder, folder: "" } : newGuardrailLocation(kind, folder, listing))}
                onMove={kind === "skill" ? undefined : (path, folder) => void move(path, folder)}
                canDropInto={
                  kind === "instruction"
                    ? (_path, folder) => !listing.instruction.some((entry) => entry.path === (folder ? `${folder}/CLAUDE.md` : "CLAUDE.md"))
                    : (_path, folder) => listing.foundDirs.rule.some((dir) => folder === dir || isInsideFolder(folder, dir))
                }
                onDelete={(entry) => void remove(entry)}
                onDeleteFolder={(folder) => void removeFolder(folder)}
              />
            ) : (
              <p className="px-4 py-2 text-[13px] text-neutral-500">{error ? null : "Loading…"}</p>
            )
          ) : (
            <>
              <ul {...listNav.listProps} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 text-[13px] outline-none">
                {rows.map((row) =>
                  row.type === "folder" ? (
                    <FolderRow
                      key={`folder:${row.folder}`}
                      folder={row.folder}
                      name={row.name}
                      depth={row.depth}
                      isExpanded={!collapsedFolders.has(row.folder)}
                      isSelected={listNav.cursor === `${row.folder}/`}
                      onToggle={() => {
                        toggleFolder(row.folder);
                        listNav.select(`${row.folder}/`);
                      }}
                    />
                  ) : (
                    <GuardrailRow
                      key={row.entry.path}
                      entry={row.entry}
                      depth={row.depth}
                      isSelected={listNav.cursor === row.entry.path}
                      isDirty={dirtyPaths.includes(row.entry.path)}
                      onSelect={() => listNav.select(row.entry.path)}
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
              <div className="@container flex h-10 shrink-0 items-center gap-2 border-b border-(--line) px-3 text-[13px]">
                <span className="min-w-0 flex-1 truncate text-neutral-400" title={`${worktreePath}/${selected.path}`}>
                  {selected.path}
                </span>
                {dirtyPaths.includes(selected.path) ? <span className="text-amber-300">Unsaved</span> : null}
                <AgentButton
                  label="Agent"
                  labelClassName="hidden @xl:inline"
                  onClick={(event) => openAgent(selected, event.currentTarget)}
                  isBusy={isFileChatBusy}
                  title={fileChat ? "Show the agent's chat about this file" : "Let the agent write this file from your instructions"}
                  aria-label={fileChat ? "Show the agent's chat about this file" : "Let the agent write this file from your instructions"}
                />
                <button type="button" onClick={() => void remove(selected)} className={DANGER_BUTTON_XS}>
                  <TrashIcon />
                  Delete
                </button>
                <button type="button" onClick={() => void save(selected.path)} disabled={!dirtyPaths.includes(selected.path)} className={PRIMARY_BUTTON_XS} title={saveShortcut ?? undefined}>
                  Save
                </button>
              </div>
              <MarkdownEditor workspace={workspace} path={selected.path} onSave={save} onError={setError} />
            </>
          ) : draft && listing ? (
            <>
              <div className="@container flex h-10 shrink-0 items-center gap-2 border-b border-(--line) px-3 text-[13px]">
                {kind === "instruction" ? (
                  <span className="min-w-0 flex-1 truncate text-neutral-400">{draftPath}</span>
                ) : (
                  <>
                    <input
                      value={draft.name}
                      onChange={(event) => {
                        const name = event.target.value;
                        setDraft({ ...draft, name, content: isDraftEdited ? draft.content : guardrailTemplate(kind, name, listing) });
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" || !canCreate) return;
                        event.preventDefault();
                        void create(draftTitle, draft.content, draft);
                      }}
                      placeholder={`Name of the new ${labels.singular} (optional, the agent chooses one)`}
                      aria-label={`Name of the new ${labels.singular}`}
                      className="min-w-0 flex-1 bg-transparent text-neutral-200 outline-none placeholder:text-neutral-500"
                    />
                    <span className="shrink-0 truncate text-neutral-600">{draftPath ?? `${draft.dir}/${draft.folder ? `${draft.folder}/` : ""}`}</span>
                  </>
                )}
                <AgentButton
                  ref={draftAgentRef}
                  label="Agent"
                  labelClassName="hidden @xl:inline"
                  onClick={(event) => openCreateAgent(event.currentTarget)}
                  isBusy={isDraftChatBusy}
                  title={draftChat ? "Show the agent's chat about this file" : "Let the agent write this file from your instructions"}
                  aria-label={draftChat ? "Show the agent's chat about this file" : "Let the agent write this file from your instructions"}
                />
                <button
                  type="button"
                  onClick={() => void create(draftTitle, draft.content, draft)}
                  disabled={!canCreate}
                  className={PRIMARY_BUTTON_XS}
                  title={canCreate ? "Create the file with this content" : "Edit the template or let the agent write the file; an unedited template is not created"}
                >
                  Create
                </button>
              </div>
              <DraftEditor
                value={draft.content}
                onChange={(content) => setDraft((current) => (current ? { ...current, content } : current))}
                onSave={() => {
                  if (!canCreate) return;
                  void create(draftTitle, draft.content, draft);
                }}
              />
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
              request={shownRequest ?? agentChat.shown.request}
              subSessionId={agentChat.shown.subSessionId}
              title={isGuardrailChat ? "New guardrail" : isCreationChat ? `New ${labels.singular}` : `Generate ${agentChat.shown.request.selection.path}`}
              placeholder={
                isGuardrailChat
                  ? "Describe the guardrail you want: what should Claude know or do, and where?"
                  : isCreationChat
                    ? `What should the new ${labels.singular} be about?`
                    : "What should this file contain?"
              }
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
function FolderRow({ folder, name, depth, isExpanded, isSelected, onToggle }: { folder: string; name: string; depth: number; isExpanded: boolean; isSelected: boolean; onToggle: () => void }) {
  return (
    <li data-tree-key={`${folder}/`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        style={{ paddingLeft: 4 + depth * ROW_INDENT }}
        className={`flex w-full items-center gap-1 rounded py-1.5 pr-2 text-left ${isSelected ? "bg-(--row-selected) text-white" : "text-neutral-400 hover:bg-(--row-hover) hover:text-white"}`}
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
    <li className="group relative" data-tree-key={entry.path}>
      <button
        type="button"
        onClick={onSelect}
        title={entry.path}
        style={{ paddingLeft: 8 + depth * ROW_INDENT }}
        className={`flex w-full items-center gap-2 rounded py-1.5 pr-8 text-left ${isSelected ? "bg-(--row-selected) text-white" : "text-neutral-300 hover:bg-(--row-hover) hover:text-white"}`}
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

/** How long the mouse rests on a tab before its kind's explanation shows. */
const HELP_OPEN_DELAY = 700;
const HELP_WIDTH = 480;
const HELP_MARGIN = 8;

/** Explanation of the hovered tab's kind below it (`anchor`); the mouse may move into it to select its text. */
function HelpTooltip({ anchor, onEnter, onLeave }: { anchor: HoverAnchor<GuardrailKind>; onEnter: () => void; onLeave: () => void }) {
  const title = KIND_LABELS[anchor.key].plural;
  const help = kindHelp(anchor.key);
  const width = Math.min(HELP_WIDTH, window.innerWidth - 2 * HELP_MARGIN);
  const left = Math.max(HELP_MARGIN, Math.min(anchor.rect.left, window.innerWidth - width - HELP_MARGIN));

  return createPortal(
    <div
      role="tooltip"
      aria-label={title}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="fixed z-50 overflow-y-auto rounded-md border border-neutral-600 bg-(--surface-inset) p-3.5 text-[14px] leading-relaxed text-neutral-200 shadow-lg shadow-black/40"
      style={{ width, left, top: anchor.rect.bottom + 4, maxHeight: window.innerHeight - anchor.rect.bottom - 4 - HELP_MARGIN }}
    >
      <h3 className="mb-1 font-semibold text-neutral-100">{title}</h3>
      <p>{help.what}</p>
      <h4 className="mt-2.5 font-semibold text-neutral-100">How it is loaded</h4>
      <p>{help.loading}</p>
      <h4 className="mt-2.5 font-semibold text-neutral-100">When to use it</h4>
      <p>{help.use}</p>
    </div>,
    document.body,
  );
}

/**
 * Monaco editor for Markdown with soft wrapping, sized like the editor panes, created without a model in the host
 * `hostRef` points to; ⌘S calls `onSave` with the editor.
 */
function useMarkdownMonaco(onSave: (editor: monaco.editor.IStandaloneCodeEditor) => void) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const fontSize = useSettingsStore((state) => state.panes.diff.fontSize);
  const lineHeight = useSettingsStore((state) => state.panes.diff.lineHeight);
  const fontFamily = useSettingsStore((state) => state.panes.diff.fontFamily);
  const latestOnSave = useRef(onSave);
  latestOnSave.current = onSave;

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
    onShortcut(editor, "editor.save", () => latestOnSave.current(editor));
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

  return { hostRef, editorRef };
}

/** Markdown editor on the workspace document of `path`; ⌘S saves it. */
function MarkdownEditor({ workspace, path, onSave, onError }: { workspace: Workspace; path: string; onSave: (path: string) => void; onError: (error: string | null) => void }) {
  const { hostRef, editorRef } = useMarkdownMonaco((editor) => {
    const shownPath = workspace.pathOf(editor.getModel()?.uri ?? monaco.Uri.parse("inmemory://none"));
    if (shownPath) {
      onSave(shownPath);
    }
  });

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

/** Markdown editor on the content of a file not written yet; it takes over `value` whenever that changes, ⌘S calls `onSave`. */
function DraftEditor({ value, onChange, onSave }: { value: string; onChange: (value: string) => void; onSave: () => void }) {
  const { hostRef, editorRef } = useMarkdownMonaco(() => onSave());
  const latestOnChange = useRef(onChange);
  latestOnChange.current = onChange;

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = monaco.editor.createModel(value, "markdown");
    const subscription = model.onDidChangeContent(() => latestOnChange.current(model.getValue()));
    editor.setModel(model);
    return () => {
      subscription.dispose();
      editor.setModel(null);
      model.dispose();
    };
    // One model per draft; later values reach it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorRef]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model || model.getValue() === value) return;
    model.setValue(value);
  }, [editorRef, value]);

  return (
    <div className="relative min-h-0 flex-1 bg-(--diff-bg)">
      <div ref={hostRef} className="absolute inset-0" />
    </div>
  );
}
