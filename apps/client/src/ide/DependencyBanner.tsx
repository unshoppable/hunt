import { commands } from "../ipc/commands";
import type { DependencyStatus } from "../sessions/session.types";
import { Spinner } from "../ui/Icons";

/**
 * Row above the editor panes while the worktree's `node_modules` is being cloned or installed, or when that
 * failed; nothing once the modules are ready. The language server restarts by itself when they are.
 */
export function DependencyBanner({ sessionId, status }: { sessionId: string; status: DependencyStatus | null }) {
  if (!status || status.phase === "ready") return null;
  const isFailed = status.phase === "failed";
  return (
    <div
      role={isFailed ? "alert" : "status"}
      className={`flex shrink-0 items-center gap-2 border-b border-(--line) px-3 py-2 text-[13px] ${isFailed ? "bg-red-400/10 text-red-300" : "bg-(--diff-bg) text-neutral-400"}`}
    >
      {isFailed ? null : <Spinner className="size-3 shrink-0" />}
      <span className="min-w-0 flex-1 truncate" title={status.message}>
        {isFailed ? `Installing dependencies failed: ${status.message}` : status.message}
      </span>
      {isFailed ? (
        <button
          type="button"
          className="shrink-0 rounded-md px-2 py-1 text-[#548af7] hover:bg-white/10 hover:text-[#7ea6ff]"
          onClick={() => void commands.prepareDependencies(sessionId)}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
