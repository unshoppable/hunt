import { useEffect, useRef, useState } from "react";
import { useSubChatPopover } from "../chat/sub-chat/sub-chat-popover.hook";
import type { DocumentWorkspace } from "../ide/documents/documents.service";
import type { SelectionChat } from "../ide/selection/selection-chats.utils";
import { useSelectionChats } from "../ide/selection/selection-chats.hook";
import { useHuntStore } from "../sessions/hunt.store";
import type { Guardrail, GuardrailKind, GuardrailListing, GuardrailLocation } from "./guardrail.types";
import { creationTask, generationTask, GUARDRAIL_CHAT_PATH, guardrailTask } from "./guardrail-tasks.utils";
import { ownerFolderOf } from "./guardrail-tree.utils";
import { KINDS } from "./guardrail-kind.utils";

/**
 * The page of a new file of a tab's kind: where it goes (for a CLAUDE.md `dir` is its folder), its name, its content
 * and the creation chats that existed before it.
 */
export type GuardrailDraft = GuardrailLocation & { name: string; content: string; earlierChats: ReadonlySet<string> };

/**
 * The sub chats of the guardrails window, shown one at a time in its popover: the chat about the open file ("Agent" in
 * the editor header), the chat that creates the draft's file (its selection names the file of a CLAUDE.md, whose path is
 * fixed, or else `draftChatPath`, the directory) and the "New" chat, whose agent creates a guardrail of any kind. A file
 * the open creation or "New" chat's agent added goes to `onCreated` while that chat stays open; `onGuardrailChatOpen`
 * runs before the "New" chat opens. Another selected file closes the popover.
 */
export function useGuardrailAgentChats({
  sessionId,
  workspace,
  kind,
  listing,
  selectedPath,
  draft,
  draftChatPath,
  onCreated,
  onGuardrailChatOpen,
}: {
  sessionId: string;
  workspace: DocumentWorkspace;
  kind: GuardrailKind;
  listing: GuardrailListing | null;
  selectedPath: string | null;
  draft: GuardrailDraft | null;
  draftChatPath: string | null;
  onCreated: (entry: Guardrail) => void;
  onGuardrailChatOpen: () => void;
}) {
  const agentChat = useSubChatPopover();
  const draftAgentRef = useRef<HTMLButtonElement>(null);
  // The creation chat whose agent wrote a file, per path, so that the file's "Agent" button shows and reopens it.
  const [creatorChats, setCreatorChats] = useState<Record<string, SelectionChat>>({});
  // Set before the file an agent just created is selected, so that the chat which created it stays open.
  const keepsAgentChat = useRef(false);
  // Every guardrail path of the last listing, to notice a file an agent added.
  const knownPaths = useRef<Set<string> | null>(null);

  // The newest sub chat about the open file, kept across popover closes; the "Agent" button reopens it.
  const fileChat = useSelectionChats(sessionId, selectedPath)[0] ?? (selectedPath ? creatorChats[selectedPath] : undefined) ?? null;
  const isFileChatBusy = useHuntStore((state) => (fileChat ? (state.chats[fileChat.sessionId]?.isBusy ?? false) : false));
  const isFileChatUnseen = useHuntStore((state) => (fileChat ? (state.chats[fileChat.sessionId]?.hasUnseenActivity ?? false) : false));
  const creationChats = useSelectionChats(sessionId, draftChatPath);
  const draftChat = draft ? (creationChats.find((chat) => !draft.earlierChats.has(chat.sessionId)) ?? null) : null;
  const isDraftChatBusy = useHuntStore((state) => (draftChat ? (state.chats[draftChat.sessionId]?.isBusy ?? false) : false));
  const isDraftChatUnseen = useHuntStore((state) => (draftChat ? (state.chats[draftChat.sessionId]?.hasUnseenActivity ?? false) : false));

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
    onCreated(added[0]);
    // Runs when the listing changes; the chat that wrote the file is read as it is then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing, kind, isCreationChat, isGuardrailChat]);

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
    onGuardrailChatOpen();
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

  return {
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
  };
}
