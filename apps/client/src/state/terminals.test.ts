import { describe, expect, it } from "vitest";
import { NO_LOCAL_TERMINALS, withoutTerminal, withScriptRun, withShell, type LocalTerminals } from "./terminals";

const RUN = { directory: "apps/web", script: "start" };

describe("withScriptRun", () => {
  it("adds a shown tab for a script that has none", () => {
    const next = withScriptRun(withShell(NO_LOCAL_TERMINALS, "shell"), RUN, "run");
    expect(next.terminals.map((terminal) => terminal.id)).toEqual(["shell", "run"]);
    expect(next.terminals[1]).toEqual({ id: "run", directory: "apps/web", script: "start", run: 0, isRunning: false });
    expect(next.activeId).toBe("run");
  });

  it("shows a running script without starting it again", () => {
    const running: LocalTerminals = { terminals: [{ id: "run", ...RUN, run: 0, isRunning: true }], activeId: null };
    expect(withScriptRun(running, RUN, "other")).toEqual({ terminals: running.terminals, activeId: "run" });
  });

  it("runs an ended script again in its tab", () => {
    const ended: LocalTerminals = { terminals: [{ id: "run", ...RUN, run: 2, isRunning: false }], activeId: null };
    const next = withScriptRun(ended, RUN, "other");
    expect(next.terminals).toEqual([{ id: "run", ...RUN, run: 3, isRunning: false }]);
    expect(next.activeId).toBe("run");
  });

  it("tells the same script of another folder apart", () => {
    const ended: LocalTerminals = { terminals: [{ id: "run", ...RUN, run: 0, isRunning: false }], activeId: "run" };
    expect(withScriptRun(ended, { directory: "", script: "start" }, "root").terminals.map((terminal) => terminal.id)).toEqual(["run", "root"]);
  });
});

describe("withoutTerminal", () => {
  const three = withShell(withShell(withShell(NO_LOCAL_TERMINALS, "a"), "b"), "c");

  it("shows the next tab after the closed one, else the one before it", () => {
    expect(withoutTerminal({ ...three, activeId: "b" }, "b")).toEqual({ terminals: [three.terminals[0], three.terminals[2]], activeId: "c" });
    expect(withoutTerminal(three, "c").activeId).toBe("b");
    expect(withoutTerminal(withShell(NO_LOCAL_TERMINALS, "a"), "a")).toEqual(NO_LOCAL_TERMINALS);
  });

  it("keeps the shown tab when another one closes and ignores unknown IDs", () => {
    expect(withoutTerminal(three, "a").activeId).toBe("c");
    expect(withoutTerminal(three, "x")).toBe(three);
  });
});
