import { useEffect, useRef } from "react";
import { commands } from "../ipc/commands";
import { listenTo } from "../ipc/events";
import type { CheckOutputEvent } from "../ipc/types";
import { decodeBase64 } from "../terminal/terminalStream";
import { useXterm } from "../terminal/useXterm";

/** Hides the cursor: the output takes no input, so a cursor would suggest that it does. */
const HIDE_CURSOR = "\u001b[?25l";

/**
 * The output of the run `run` of the check `name`, read-only in the Terminal pane's font and colors: what the run has
 * written so far, then what it writes from now on. Mount it with a key per run, so a new run starts with an empty view.
 */
export function CheckOutput({ sessionId, name, run }: { sessionId: string; name: string; run: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const { view, background } = useXterm(hostRef, { isStarted: true, isReadOnly: true });

  useEffect(() => {
    if (!view) return;
    const { terminal } = view;
    terminal.write(HIDE_CURSOR);
    /** The offset up to which the view shows the output; `null` until the output so far has arrived. */
    let shownEnd: number | null = null;
    const pending: CheckOutputEvent[] = [];
    let isDisposed = false;

    const show = (event: CheckOutputEvent) => {
      if (shownEnd === null) return;
      const bytes = decodeBase64(event.data);
      const skipped = Math.max(0, shownEnd - event.offset);
      if (skipped >= bytes.length) return;
      terminal.write(bytes.subarray(skipped));
      shownEnd = event.offset + bytes.length;
    };

    const subscription = listenTo("checks:output", (event) => {
      if (event.sessionId !== sessionId || event.name !== name || event.run !== run) return;
      if (shownEnd === null) {
        pending.push(event);
        return;
      }
      show(event);
    });
    void subscription
      .then(() => commands.checkOutput(sessionId, name))
      .then((output) => {
        if (isDisposed) return;
        if (output && output.run === run) {
          terminal.write(decodeBase64(output.data));
          shownEnd = output.end;
        } else {
          shownEnd = 0;
        }
        for (const event of pending) {
          show(event);
        }
      })
      .catch((reason) => console.error("failed to read the check's output", reason));
    return () => {
      isDisposed = true;
      void subscription.then((unlisten) => unlisten());
    };
  }, [view, sessionId, name, run]);

  return (
    <div className="min-h-0 flex-1 overflow-hidden p-2" style={{ background }}>
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}
