import { useEffect, useState } from "react";
import { commands } from "../ipc/commands";
import { retrieveBlocker } from "../chat/remoteSession";
import { useHuntStore } from "../state/store";
import { BUTTON_MD, DANGER, GHOST_BUTTON_MD, PRIMARY_BUTTON_MD } from "../ui/buttons";
import { Modal } from "../ui/Modal";
import { errorText } from "../ui/useLoad";
import { confirmVmLoss } from "./confirmVmLoss";
import { idleDays, isStaleRemote } from "./staleRemote";

/** How often the main window looks for remote sessions that are idle long enough to ask about. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Asks, one session at a time, whether to retrieve or delete a remote session that has been idle on the VM for a week
 * (`isStaleRemote`), since it takes space there until then. "Later" asks again three days later. Checks at launch and
 * every six hours. For an adopted session both answers ask once more, naming the VM others may work on.
 */
export function StaleRemoteDialog() {
  const sessions = useHuntStore((state) => state.sessions);
  const retrieveSession = useHuntStore((state) => state.retrieveSession);
  const closeSession = useHuntStore((state) => state.closeSession);
  const [now, setNow] = useState(() => Date.now());
  /** Sessions answered in this window, so none comes back before the refreshed session list reflects the answer. */
  const [answeredIds, setAnsweredIds] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  const session = sessions.find((candidate) => !answeredIds.has(candidate.id) && isStaleRemote(candidate, now));
  if (!session) return null;
  const blocker = retrieveBlocker(session);
  const days = idleDays(session, now);

  const answer = async (action: "delete" | "bringBack") => {
    if (!(await confirmVmLoss(session, action))) return;
    setError(null);
    setAnsweredIds((ids) => new Set(ids).add(session.id));
    void (action === "delete" ? closeSession(session.id, true) : retrieveSession(session.id));
  };

  const later = async () => {
    try {
      await commands.snoozeRemoteCleanup(session.id);
      setError(null);
      setAnsweredIds((ids) => new Set(ids).add(session.id));
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  return (
    <Modal label="Idle remote session" onClose={() => void later()} className="w-[460px] bg-(--surface-chat) p-4">
      <h2 className="mb-1 text-base font-semibold">Idle remote session</h2>
      <p className="mb-2 text-[13px] text-neutral-300">
        "{session.title}" has been idle on its VM for {days} days, whose disk costs money while it waits. Retrieve it to continue here, or delete it together with its VM,
        including work you have not retrieved.
      </p>
      {blocker ? <p className="mb-2 text-[13px] text-neutral-400">{blocker}</p> : null}
      {error ? <p className="mb-2 text-[13px] break-words text-red-300">{error}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={() => void later()} className={GHOST_BUTTON_MD}>
          Later
        </button>
        <button type="button" onClick={() => void answer("delete")} className={`${BUTTON_MD} ${DANGER}`}>
          Delete
        </button>
        <button type="button" onClick={() => void answer("bringBack")} disabled={!!blocker} autoFocus className={PRIMARY_BUTTON_MD}>
          Retrieve
        </button>
      </div>
    </Modal>
  );
}
