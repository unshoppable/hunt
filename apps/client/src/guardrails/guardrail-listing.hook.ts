import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { DocumentWorkspace } from "../ide/documents/documents.service";
import type { GuardrailListing } from "./guardrail.types";
import { listGuardrails } from "./guardrail-listing.service";
import { ensureGuardrailReadmes } from "./guardrail-readmes.utils";

/**
 * The guardrails of the session `sessionId` as last listed, listed again whenever the window is brought back, and the
 * paths of `workspace` with unsaved edits. `refresh` lists them again and resolves with the new listing, or with `null`
 * when that failed; `onError` gets the failure, and `null` after a successful listing.
 */
export function useGuardrailListing(sessionId: string, workspace: DocumentWorkspace, onError: (error: string | null) => void) {
  const [listing, setListing] = useState<GuardrailListing | null>(null);
  const [dirtyPaths, setDirtyPaths] = useState<string[]>([]);
  // Times the window was brought back, so that the lint rules tab reads the configs again.
  const [focusCount, setFocusCount] = useState(0);

  const refresh = useCallback(() => {
    return listGuardrails(sessionId)
      .then((next) => {
        setListing(next);
        onError(null);
        void ensureGuardrailReadmes(sessionId, next.dirs);
        return next;
      })
      .catch((reason) => {
        onError(String(reason));
        return null;
      });
  }, [sessionId, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A window booted ahead of time or hidden by its close reads the listing again whenever it is brought back.
  useEffect(() => {
    const subscription = getCurrentWindow().onFocusChanged(({ payload: isFocused }) => {
      if (isFocused) {
        void refresh();
        setFocusCount((count) => count + 1);
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

  return { listing, dirtyPaths, focusCount, refresh };
}
