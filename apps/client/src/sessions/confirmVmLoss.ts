import type { SessionView } from "../ipc/types";
import { confirmDestructive } from "../ui/confirm";
import { adoptedBringBackQuestion, adoptedDeleteQuestion, isAdopted } from "./remoteOrigin";

/**
 * Asks before an action that deletes the VM of the adopted `session` for everybody working on it: deleting the session
 * or bringing it back. Resolves true without asking for any other session.
 */
export function confirmVmLoss(session: SessionView, action: "delete" | "bringBack"): Promise<boolean> {
  if (!isAdopted(session)) return Promise.resolve(true);
  return action === "delete"
    ? confirmDestructive(adoptedDeleteQuestion(session), "Delete")
    : confirmDestructive(adoptedBringBackQuestion(session), "Bring back");
}
