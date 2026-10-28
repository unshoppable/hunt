import { useEffect, useRef, useState } from "react";
import { useHuntStore } from "../hunt.store";
import { REMOTE_STEP_LABELS, worktreeLock } from "./remote-session.utils";

/** What a chat of a locked worktree shows, and the remote session (`ownerId`) whose VM the connect is about. */
export type VmConnect = {
  ownerId: string;
  /** Why the worktree may not change right now (see `worktreeLock`); `null` while it may. */
  lock: "vmRunning" | "unreachable" | null;
  /** The connect to the VM runs or is about to start; the worktree stays read-only until it succeeded. */
  isConnecting: boolean;
  /** The connect failed; the chat offers to try again. */
  hasConnectFailed: boolean;
  /** The step the connect is at, as the chat of the remote session shows it; `null` between steps. */
  stepLabel: string | null;
};

/**
 * Connects the remote session whose worktree `sessionId` works in (the session itself, or the parent of a sub chat)
 * as soon as the worktree is locked because its VM runs without a connection, instead of leaving the files read-only
 * until someone clicks: the connect brings the sync back, which lifts the lock. One attempt per lock; a failed one
 * leaves the lock in place and reports `hasConnectFailed` until a click tries again. A worktree locked because the VM
 * cannot be reached is not connected; the chat offers to continue locally then.
 */
export function useVmConnect(sessionId: string): VmConnect {
  const ownerId = useHuntStore((state) => state.sessions.find((candidate) => candidate.id === sessionId)?.parentId ?? sessionId);
  const lock = useHuntStore((state) => worktreeLock(state.sessions, state.remoteLinks, sessionId));
  const isOwnerLive = useHuntStore((state) => Boolean(state.sessions.find((candidate) => candidate.id === ownerId)?.isLive));
  const isOwnerStarting = useHuntStore((state) => {
    const chat = state.chats[ownerId];
    return Boolean(chat?.isLoading || chat?.move) || state.creatingIds.includes(ownerId);
  });
  const stepLabel = useHuntStore((state) => {
    const step = state.chats[ownerId]?.remoteStep;
    return step ? REMOTE_STEP_LABELS[step] : null;
  });
  const resumeSession = useHuntStore((state) => state.resumeSession);
  const [failedOwnerId, setFailedOwnerId] = useState<string | null>(null);
  /** The owner this hook already tried to connect for the current lock; a lift of the lock allows a new attempt. */
  const attemptedOwnerRef = useRef<string | null>(null);

  const shouldConnect = lock === "vmRunning" && !isOwnerLive && !isOwnerStarting;
  useEffect(() => {
    if (lock !== "vmRunning") {
      attemptedOwnerRef.current = null;
      setFailedOwnerId(null);
      return;
    }
    if (!shouldConnect || attemptedOwnerRef.current === ownerId) return;
    attemptedOwnerRef.current = ownerId;
    void resumeSession(ownerId).then(() => {
      if (!useHuntStore.getState().sessions.find((candidate) => candidate.id === ownerId)?.isLive) {
        setFailedOwnerId(ownerId);
      }
    });
  }, [lock, shouldConnect, ownerId, resumeSession]);

  const hasConnectFailed = lock === "vmRunning" && failedOwnerId === ownerId;
  return { ownerId, lock, isConnecting: lock === "vmRunning" && !hasConnectFailed, hasConnectFailed, stepLabel };
}
