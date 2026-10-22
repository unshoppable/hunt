import { useEffect, useRef, useState } from "react";
import type { Description } from "../preview/services";
import { NO_LOCAL_TERMINALS, useTerminalStore, type LocalTerminal } from "../state/terminals";
import { ICON_BUTTON_XS, SECONDARY_BUTTON_XS } from "../ui/buttons";
import { confirmDestructive } from "../ui/confirm";
import { PlusIcon } from "../ui/icons";
import { TerminalTabButton } from "./TerminalTabButton";
import { TerminalView } from "./TerminalView";

const RUNNING: Description = { text: "Running", tone: "ok" };
const ENDED: Description = { text: "Ended", tone: "idle" };

/** The label of each terminal: a script's name, or "shell", "shell 2", … for the shells. */
function terminalLabels(terminals: readonly LocalTerminal[]): string[] {
  let shellCount = 0;
  return terminals.map((terminal) => {
    if (terminal.script) return terminal.script;
    shellCount += 1;
    return shellCount === 1 ? "shell" : `shell ${shellCount}`;
  });
}

/**
 * The Terminal tab of a local session: login shells and package.json script runs in its worktree, one tab each. "+"
 * opens a shell, × ends a terminal and its process. A shell whose program ends closes its tab; a script's tab keeps its
 * output until it runs again or closes. The main window keeps the panel of every session with terminals mounted while
 * another session or tab shows, so they keep running; the first time the panel shows without any, it opens a shell.
 */
export function LocalTerminalPanel({ sessionId, isVisible }: { sessionId: string; isVisible: boolean }) {
  const { terminals, activeId } = useTerminalStore((state) => state.local[sessionId] ?? NO_LOCAL_TERMINALS);
  const openShell = useTerminalStore((state) => state.openShell);
  const showTerminal = useTerminalStore((state) => state.showTerminal);
  const closeTerminal = useTerminalStore((state) => state.closeTerminal);
  const setRunning = useTerminalStore((state) => state.setRunning);
  /** Bumped whenever the panel shows or shows another terminal; each value focuses the shown terminal once. */
  const [focusCount, setFocusCount] = useState(0);
  const hasShownRef = useRef(false);
  const labels = terminalLabels(terminals);

  useEffect(() => {
    if (!isVisible || hasShownRef.current) return;
    hasShownRef.current = true;
    if (!terminals.length) {
      openShell(sessionId);
    }
  }, [isVisible, terminals.length, openShell, sessionId]);

  useEffect(() => {
    if (isVisible) {
      setFocusCount((current) => current + 1);
    }
  }, [isVisible, activeId]);

  const close = async (terminal: LocalTerminal, label: string) => {
    if (terminal.script && terminal.isRunning) {
      const isConfirmed = await confirmDestructive(`End "${label}"? The script stops.`, "End");
      if (!isConfirmed) return;
    }
    closeTerminal(sessionId, terminal.id);
  };

  return (
    <div className={`h-full min-h-0 flex-col ${isVisible ? "flex" : "hidden"}`}>
      <div className="flex min-w-0 items-center gap-1 border-b border-(--line) px-2 py-2.5 text-[13px]">
        <div role="tablist" className="terminal-tabs flex min-w-0 items-center gap-1 overflow-x-auto">
          {terminals.map((terminal, index) => (
            <TerminalTabButton
              key={terminal.id}
              label={labels[index]}
              title={terminal.script ? `npm run ${terminal.script} in ${terminal.directory || "the worktree"}` : "A shell in the worktree"}
              state={terminal.script ? (terminal.isRunning ? RUNNING : ENDED) : null}
              isActive={terminal.id === activeId}
              onActivate={() => showTerminal(sessionId, terminal.id)}
              onClose={() => void close(terminal, labels[index])}
            />
          ))}
        </div>
        <button type="button" onClick={() => openShell(sessionId)} title="New shell" className={ICON_BUTTON_XS}>
          <PlusIcon />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {terminals.map((terminal) => (
          <TerminalView
            key={`${terminal.id}:${terminal.run}`}
            sessionId={sessionId}
            target={{ kind: "shell", directory: terminal.directory, script: terminal.script }}
            isVisible={isVisible && terminal.id === activeId}
            focusRequest={terminal.id === activeId ? focusCount : 0}
            onRunningChange={(isRunning) => setRunning(sessionId, terminal.id, isRunning)}
            onExit={terminal.script ? undefined : () => closeTerminal(sessionId, terminal.id)}
          />
        ))}
        {terminals.length ? null : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-[13px] text-neutral-500">
            <p>No terminal is open.</p>
            <button type="button" onClick={() => openShell(sessionId)} className={SECONDARY_BUTTON_XS}>
              New shell
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
