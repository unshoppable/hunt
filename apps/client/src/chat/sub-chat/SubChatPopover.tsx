import { useEffect, useMemo, useState } from "react";
import type { SelectionRequest } from "../../editor/selection-request.monaco";
import type { GuardrailDeclineReason } from "../guardrail/guardrail-suggestion.types";
import type { GuardrailKind } from "../../guardrails/guardrail.types";
import { useSettingsStore } from "../../settings/settings.store";
import { useHuntStore } from "../../sessions/hunt.store";
import type { PopupActions } from "../../ui/popup-protocol.utils";
import { useDetachedPopup } from "../../ui/detached-popup.hook";
import { SubChatView, type ParentAgent, type SubChatViewProps } from "./SubChatView";

export type SubChatPopoverProps = {
  /** The session whose code view shows the popover; a new sub chat becomes its sub session. */
  parentSessionId: string;
  request: SelectionRequest;
  /** An existing sub session to show; without it, the first question creates one. */
  subSessionId?: string;
  /** Header text instead of "Sub chat about <file> <lines>"; the selection card is left out then, the title says what the chat is about. */
  title?: string;
  /** Placeholder of the first question's textarea. */
  placeholder?: string;
  /** Context the new sub chat's agent gets besides the question, shown as a collapsed card until the first question is sent. */
  context?: { label: string; text: string };
  /**
   * The suggested guardrail the popover was opened to take up: its kind and the summary of the conversation it comes
   * from, shown as a card until the first question is sent.
   */
  suggestedGuardrail?: { kind: GuardrailKind; conversationSummary: string[] };
  /** Text the first question's textarea starts with; the caret is placed after it. */
  initialText?: string;
  /** Called after the user moved or resized the popover, with how far its anchored corner now sits from the anchor. */
  onPlaced?: (offset: { x: number; y: number }) => void;
  /**
   * Declines what the popover was opened to take up (a suggested guardrail). Shows a "Decline" button above the send
   * button until the first question is sent; it asks for the reason, then calls `onDecline` with it and closes the popover.
   */
  onDecline?: (reason: GuardrailDeclineReason) => void;
  /** Called once the first question created the sub session, which takes up what the popover was opened for. */
  onAccept?: () => void;
  onClose: () => void;
};

/** What the sub chat window shows (see detached-popup.hook.ts); `canDecline` stands for the host's `onDecline`. */
export type SubChatContent = Pick<SubChatPopoverProps, "parentSessionId" | "request" | "subSessionId" | "title" | "placeholder" | "context" | "suggestedGuardrail" | "initialText"> & {
  parentAgent: ParentAgent | null;
  canDecline: boolean;
  unreadAfterMessageId: string | null;
};

/**
 * Floating chat next to a code selection (see `SubChatView`), inside the app window or in a window of its own, as the
 * user chose (see detached-popup.hook.ts). It keeps the sub session the first question created, so that the conversation
 * stays when the user switches between the two. A reply counts as seen while the popover shows it; the "unread" line
 * stays where the unseen activity began when the popover opened.
 */
export function SubChatPopover({ subSessionId, onAccept, ...props }: SubChatPopoverProps) {
  const isDetached = useSettingsStore((state) => state.detachedPopups.subChat);
  const [createdSubSessionId, setCreatedSubSessionId] = useState<string | null>(null);
  const shownSubSessionId = createdSubSessionId ?? subSessionId;
  const hasUnseenActivity = useHuntStore((state) => (shownSubSessionId ? (state.chats[shownSubSessionId]?.hasUnseenActivity ?? false) : false));
  const unseenAfterMessageId = useHuntStore((state) => (shownSubSessionId ? (state.chats[shownSubSessionId]?.unseenAfterMessageId ?? null) : null));
  // Taken at the first render: marking the chat seen clears the store's value right after.
  const [unreadAfterMessageId] = useState(unseenAfterMessageId);
  const markChatSeen = useHuntStore((state) => state.markChatSeen);
  useEffect(() => {
    if (!shownSubSessionId || !hasUnseenActivity) return;
    markChatSeen(shownSubSessionId);
  }, [shownSubSessionId, hasUnseenActivity, markChatSeen]);
  const onCreated = (id: string) => {
    setCreatedSubSessionId(id);
    onAccept?.();
  };
  if (isDetached) {
    return <DetachedSubChat {...props} subSessionId={shownSubSessionId} unreadAfterMessageId={unreadAfterMessageId} onCreated={onCreated} />;
  }
  return <SubChatView {...props} subSessionId={shownSubSessionId} unreadAfterMessageId={unreadAfterMessageId} isDetached={false} onCreated={onCreated} />;
}

/** The sub chat window's host side: hands the chat over and passes on what the user decides there. */
function DetachedSubChat({
  parentSessionId,
  request,
  subSessionId,
  title,
  placeholder,
  context,
  suggestedGuardrail,
  initialText,
  unreadAfterMessageId = null,
  onDecline,
  onCreated,
  onClose,
}: Omit<SubChatViewProps, "isDetached">) {
  const configOptions = useHuntStore((state) => state.chats[parentSessionId]?.configOptions);
  const modeId = useHuntStore((state) => state.chats[parentSessionId]?.modeId);
  const parentAgent = configOptions && modeId !== undefined ? { configOptions, modeId } : null;
  // Hosts build `request` and `context` anew on each render; the window gets them again only when they changed.
  const serialized = JSON.stringify({
    parentSessionId,
    request,
    subSessionId,
    title,
    placeholder,
    context,
    suggestedGuardrail,
    initialText,
    parentAgent,
    canDecline: !!onDecline,
    unreadAfterMessageId,
  } satisfies SubChatContent);
  const content = useMemo(() => JSON.parse(serialized) as SubChatContent, [serialized]);
  useDetachedPopup("subChat", content, {
    // Each sub chat mounts anew (see `useSubChatPopover`), so its window takes the focus once per showing.
    revision: null,
    anchor: () => {
      const { x, y, corner } = request.anchor;
      if (corner !== "bottomRight") return { x, y };
      const size = useSettingsStore.getState().popupSizes.subChat;
      return { x: x - size.width, y: y - size.height };
    },
    onAction: (action: PopupActions["subChat"]) => {
      if (action.type === "created") {
        onCreated(action.subSessionId);
      } else {
        onDecline?.(action.reason);
      }
    },
    onClose,
  });
  return null;
}

/** The sub chat in its own window (see PopupWindow.tsx); a declined offer goes back to the host window. */
export function SubChatWindowContent({ content, onAction, onClose }: { content: SubChatContent; onAction: (action: PopupActions["subChat"]) => void; onClose: () => void }) {
  return (
    <SubChatView
      parentSessionId={content.parentSessionId}
      request={content.request}
      subSessionId={content.subSessionId}
      title={content.title}
      placeholder={content.placeholder}
      context={content.context}
      suggestedGuardrail={content.suggestedGuardrail}
      initialText={content.initialText}
      parentAgent={content.parentAgent}
      unreadAfterMessageId={content.unreadAfterMessageId}
      isDetached
      onDecline={content.canDecline ? (reason) => onAction({ type: "decline", reason }) : undefined}
      onCreated={(subSessionId) => onAction({ type: "created", subSessionId })}
      onClose={onClose}
    />
  );
}
