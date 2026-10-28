import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { SubChatPopover } from "../chat/sub-chat/SubChatPopover";
import { useFileIconUrl } from "../ui/file-icons/file-icons.hook";
import { workspaceFor } from "../ide/documents/documents.service";
import { selectionChatsFor } from "../ide/selection/selection-chats.utils";
import { commands } from "../ipc/commands";
import { useHuntStore } from "../sessions/hunt.store";
import { AgentButton } from "../ui/AgentButton";
import { HEADER_BAR } from "../ui/bars.constants";
import { useShortcutLabel } from "../ui/shortcut-label.hook";
import { AGENT_GLOW, BUTTON_XS, DANGER_BUTTON_XS, PRIMARY_BUTTON_LG, PRIMARY_BUTTON_XS, SECONDARY_BUTTON_XS } from "../ui/buttons.constants";
import { confirmDestructive } from "../ui/confirm.utils";
import { useHoverAnchor } from "../ui/hover-anchor.hook";
import { PlusIcon, SparkleIcon, TrashIcon } from "../ui/Icons";
import { hideCurrentWindow } from "../ui/native-window.utils";
import { useSecondaryWindow } from "../ui/secondary-window.hook";
import { baseName, isInsideFolder } from "../common/path/path.utils";
import { toggleInCollapsed } from "../common/tree/tree-expansion.utils";
import { useTreeNavigation } from "../ui/tree-navigation.hook";
import { errorText } from "../ui/error-text.utils";
import type { Guardrail, GuardrailKind, GuardrailLocation } from "./guardrail.types";
import { KIND_LABELS, KINDS } from "./guardrail-kind.utils";
import { guardrailDeleteTarget, guardrailPath, guardrailTemplate } from "./guardrail-paths.utils";
import { guardrailListRows, newGuardrailLocation, treeFolders } from "./guardrail-tree.utils";
import { GuardrailTree } from "./GuardrailTree";
import { GuardrailList } from "./GuardrailList";
import { GuardrailHelpTooltip, HELP_OPEN_DELAY, type GuardrailTab } from "./GuardrailHelpTooltip";
import { MarkdownEditor } from "./MarkdownEditor";
import { DraftEditor } from "./DraftEditor";
import { useGuardrailListing } from "./guardrail-listing.hook";
import { useGuardrailAgentChats, type GuardrailDraft } from "./guardrail-agent-chats.hook";
import { LINT_TAB_LABEL } from "./lint-rules.utils";
import { LintRulesPane } from "./LintRulesPane";

/**
 * The repository's guardrails as a window of its own (see guardrailsWindow.ts), opened from the chat header: the
 * `CLAUDE.md` instruction files anywhere in the session's worktree, its rules (`.claude/rules`), skills
 * (`.claude/skills/<name>/SKILL.md`), subagents (`.claude/agents`) and architectural decision records
 * (`.claude/resources/adrs` unless hunt.json sets `adrDir`, see `readGuardrailDirs`), one tab each. Rules and skills
 * are also read from the same directory below any folder of the worktree (`src/api/.claude/rules`), which Claude Code
 * loads once it works in that folder. The help button at the right of the tab bar explains the active tab's kind in a popover; "New" at
 * the right of the tab bar opens a sub chat whose agent turns the user's description into the guardrail kind that
 * fits, asking back while that is unclear, and the file it creates opens. The list on the left opens a file in the
 * Markdown editor on the right: instructions, rules and skills in a tree of the worktree's folders (see
 * GuardrailTree.tsx), agents and ADRs as a flat list. In the tree, the "+" of a folder opens the page of a new
 * CLAUDE.md in it or of a new rule or skill in that folder's `.claude` directory, the trash button of a row or of
 * the editor header deletes a file (a skill with its folder) after asking, the trash button of a folder deletes it
 * with everything in it, and a CLAUDE.md or rule dragged onto another folder moves there. The page of a new file
 * ("New …" or "+") shows the kind's template in the editor, with an optional name for all but a CLAUDE.md, and
 * opens its agent chat: "Create" (or ⌘S) writes the template once it was edited (an unedited one is never written,
 * leaving the page drops it), and the sub chat (see chat/sub-chat/SubChatPopover.tsx) lets an agent write the file, under
 * the name or one the agent chooses; the file opens as soon as it appears. "Agent" in the editor header opens a sub chat whose agent writes the open file
 * from the user's instructions; once that sub chat exists, the button shows whether its agent is working and
 * reopens the same chat after the popover was closed. The editor reloads the file after every edit an agent of the
 * worktree finishes. The last tab lists the ESLint rules of the worktree instead (see LintRulesPane.tsx). ⌘S or "Save" writes the file; the traffic light, Escape and ⌘W hide the window (after asking
 * about unsaved edits). It closes itself once its session was removed.
 */
export function GuardrailsWindow({ sessionId, isWarm }: { sessionId: string; isWarm: boolean }) {
  const saveShortcut = useShortcutLabel("editor.save");
  const session = useHuntStore((state) => state.sessions.find((candidate) => candidate.id === sessionId) ?? null);
  const refreshSessions = useHuntStore((state) => state.refreshSessions);
  const worktreePath = session?.worktreePath ?? "";
  const noteWorktreeChanged = useHuntStore((state) => state.noteWorktreeChanged);
  const fileIconUrl = useFileIconUrl();
  const [isLoaded, setIsLoaded] = useState(false);
  const workspace = workspaceFor(sessionId, worktreePath);
  const [kind, setKind] = useState<GuardrailKind>("instruction");
  const [isLintTab, setIsLintTab] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(new Set());
  const helpHover = useHoverAnchor<GuardrailTab>(HELP_OPEN_DELAY);
  // The page of a new file of this tab's kind ("New …" or the "+" of a tree folder): where it goes (for a CLAUDE.md
  // `dir` is its folder), its name, and the creation chats that existed before it. Its content starts as the
  // template and follows the name until it is edited; it is written only once edited.
  const [draft, setDraft] = useState<GuardrailDraft | null>(null);
  // Edits finished by any agent working in this worktree (the session's own or a sub chat's), to reload the open file.
  const editVersion = useHuntStore((state) =>
    state.sessions.filter((candidate) => candidate.worktreePath === worktreePath).reduce((sum, candidate) => sum + (state.chats[candidate.id]?.editVersion ?? 0), 0),
  );

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

  const { listing, dirtyPaths, focusCount, refresh } = useGuardrailListing(sessionId, workspace, setError);

  const entries = listing?.[kind] ?? [];
  const selected = entries.find((entry) => entry.path === selectedPath) ?? null;
  /** The title the draft's path and template derive from: a CLAUDE.md's folder, otherwise the typed name. */
  const draftTitle = draft ? (kind === "instruction" ? draft.dir : draft.name) : "";
  const draftPath = draft && listing ? guardrailPath(kind, draftTitle, listing, draft) : null;
  const isDraftEdited = !!draft && !!listing && draft.content !== guardrailTemplate(kind, draftTitle, listing);
  /** Whether "Create" may write the draft: the template was edited and, unless it is a CLAUDE.md, a name was typed. */
  const canCreate = isDraftEdited && (kind === "instruction" || !!draft?.name.trim());
  // Sub chats that create the draft's file; their selection names the file (a CLAUDE.md, whose path is fixed) or the directory.
  const draftChatPath = draft ? (kind === "instruction" ? draftPath : draft.dir) : null;

  const {
    agentChat,
    draftAgentRef,
    fileChat,
    isFileChatBusy,
    isFileChatUnseen,
    draftChat,
    isDraftChatBusy,
    isDraftChatUnseen,
    isCreationChat,
    isGuardrailChat,
    shownRequest,
    openAgent,
    openCreateAgent,
    openGuardrailAgent,
  } = useGuardrailAgentChats({
    sessionId,
    workspace,
    kind,
    listing,
    selectedPath,
    draft,
    draftChatPath,
    onCreated: (entry) => {
      setDraft(null);
      setKind(entry.kind);
      setSelectedPath(entry.path);
    },
    onGuardrailChatOpen: () => setIsLintTab(false),
  });

  /** Opens `path` in the editor; the page of a new file closes. */
  const select = (path: string | null) => {
    setDraft(null);
    setSelectedPath(path);
  };

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
    const folders = guardrailListRows(entries).flatMap((row) => (row.type === "folder" ? [row.folder] : []));
    setCollapsedFolders((current) => toggleInCollapsed(current, folder, folders));
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
    setIsLintTab(false);
    setKind(next);
    select(null);
    setCollapsedFolders(new Set());
  };

  // A warm window stays hidden until the main window shows it (see guardrails-window.utils.ts); hiding keeps unsaved edits.
  useSecondaryWindow("guardrails", hideCurrentWindow, { isReady: !isWarm });

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
              aria-selected={!isLintTab && candidate === kind}
              onClick={() => selectKind(candidate)}
              onMouseEnter={(event) => helpHover.enter(candidate, event.currentTarget)}
              onMouseLeave={helpHover.leave}
              className={`${BUTTON_XS} ${!isLintTab && candidate === kind ? "bg-(--row-active) text-white" : "text-neutral-400 hover:bg-(--row-hover) hover:text-white"}`}
            >
              {KIND_LABELS[candidate].plural}
              {listing ? <span className="ml-1 text-[13px] text-neutral-500">{listing[candidate].length}</span> : null}
            </button>
          ))}
          <button
            type="button"
            role="tab"
            aria-selected={isLintTab}
            onClick={() => {
              setIsLintTab(true);
              agentChat.close();
            }}
            onMouseEnter={(event) => helpHover.enter("lint", event.currentTarget)}
            onMouseLeave={helpHover.leave}
            className={`${BUTTON_XS} ${isLintTab ? "bg-(--row-active) text-white" : "text-neutral-400 hover:bg-(--row-hover) hover:text-white"}`}
          >
            {LINT_TAB_LABEL}
          </button>
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
      {helpHover.anchor ? <GuardrailHelpTooltip anchor={helpHover.anchor} onEnter={helpHover.keep} onLeave={helpHover.leave} /> : null}

      {error ? <p className="border-b border-(--line) px-4 py-1.5 text-[13px] text-red-400">{error}</p> : null}

      {isLintTab ? <LintRulesPane sessionId={sessionId} reloadVersion={editVersion + focusCount} /> : null}
      {/* Stays mounted behind the lint rules tab, so that the open file and its unsaved edits are there on return. */}
      <div className={`min-h-0 flex-1 ${isLintTab ? "hidden" : "flex"}`}>
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
            <GuardrailList
              rows={rows}
              collapsedFolders={collapsedFolders}
              navigation={listNav}
              dirtyPaths={dirtyPaths}
              emptyText={listing && !entries.length ? `No ${labels.plural.toLowerCase()} in this repository yet.` : null}
              isLoading={!listing && !error}
              onToggleFolder={toggleFolder}
              onDelete={(entry) => void remove(entry)}
            />
          )}
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          {selected ? (
            <>
              <div className="@container flex h-10 shrink-0 items-center gap-2 border-b border-(--line) px-3 text-[13px]">
                <img src={fileIconUrl(selected.path)} alt="" className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-neutral-400" title={`${worktreePath}/${selected.path}`}>
                  {selected.path}
                </span>
                {dirtyPaths.includes(selected.path) ? <span className="text-amber-300">Unsaved</span> : null}
                <AgentButton
                  label="Agent"
                  labelClassName="hidden @xl:inline"
                  onClick={(event) => openAgent(selected, event.currentTarget)}
                  isBusy={isFileChatBusy}
                  hasUnseenReply={isFileChatUnseen}
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
                  hasUnseenReply={isDraftChatUnseen}
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
              onClose={agentChat.close}
            />
          ) : null}
        </section>
      </div>
    </div>
  );
}
