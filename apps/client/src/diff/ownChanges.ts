import { diffArrays } from "diff";
import type { FileVersion } from "../ipc/types";

/** A line that existed at some point of a file's history; deleted lines stay in place as tombstones. */
type LineNode = {
  text: string;
  /** The line is in the base version or was added by the own session. */
  isOwnOrigin: boolean;
  /** The own session added the line. */
  isOwnAddition: boolean;
  isAlive: boolean;
  isDeletedByOwn: boolean;
  /** The step that deleted the line: its index in the history and its session (`null` for a step without one). */
  deletion: { step: number; sessionId: string | null } | null;
};

type Step = { index: number; sessionId: string | null; isOwn: boolean };

/** Lines the own session added that are no longer on disk because a later step deleted or rewrote them. */
export type Overwrite = {
  /** 1-based first and last line in the own content. */
  startLine: number;
  endLine: number;
  /** Sessions whose steps deleted the lines, the last one last; `null` stands for a change outside every tool call. */
  sessionIds: (string | null)[];
  /** The lines in their place on disk, without line breaks; empty when they were deleted without replacement. */
  diskLines: string[];
};

/** The file as only the own session changed it, and where the disk no longer holds the own lines. */
export type OwnView = { content: string; overwrites: Overwrite[] };

/** Lines of `text` with their line breaks; a last line without a break is kept as is. */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function joinLines(lines: string[]): string {
  return lines.map((line, index) => (index < lines.length - 1 && !line.endsWith("\n") ? `${line}\n` : line)).join("");
}

/** Applies one version step to the line history: removed lines become tombstones, added lines are inserted after them. */
function applyStep(nodes: LineNode[], nextLines: string[], step: Step): LineNode[] {
  const alive = nodes.filter((node) => node.isAlive);
  const result: LineNode[] = [];
  let aliveIndex = 0;
  let nodeIndex = 0;
  for (const part of diffArrays(alive.map((node) => node.text), nextLines)) {
    if (part.added) {
      for (const text of part.value) {
        result.push({ text, isOwnOrigin: step.isOwn, isOwnAddition: step.isOwn, isAlive: true, isDeletedByOwn: false, deletion: null });
      }
      continue;
    }
    for (let count = 0; count < part.value.length; count++) {
      const node = alive[aliveIndex++];
      while (nodes[nodeIndex] !== node) {
        result.push(nodes[nodeIndex++]);
      }
      nodeIndex++;
      result.push(part.removed ? { ...node, isAlive: false, isDeletedByOwn: step.isOwn, deletion: { step: step.index, sessionId: step.sessionId } } : node);
    }
  }
  return result.concat(nodes.slice(nodeIndex));
}

const isShown = (node: LineNode) => node.isOwnOrigin && !node.isDeletedByOwn;

/**
 * Runs of shown lines the own session added and another step deleted, each with the lines that sit in their place on
 * disk: the live lines between the shown lines around the run.
 */
function collectOverwrites(nodes: LineNode[]): Overwrite[] {
  const overwrites: Overwrite[] = [];
  let line = 0;
  /** Index of the last shown node outside a run, where the disk lines of the next run start after. */
  let anchorIndex = -1;
  let run: { startLine: number; endLine: number; afterIndex: number; deletions: Map<string | null, number> } | null = null;
  const closeRun = (beforeIndex: number) => {
    if (!run) return;
    const sessionIds = [...run.deletions].sort((first, second) => first[1] - second[1]).map(([sessionId]) => sessionId);
    const diskLines = nodes
      .slice(run.afterIndex + 1, beforeIndex)
      .filter((node) => node.isAlive)
      .map((node) => node.text.replace(/\n$/, ""));
    overwrites.push({ startLine: run.startLine, endLine: run.endLine, sessionIds, diskLines });
    run = null;
  };
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (!isShown(node)) continue;
    line++;
    if (node.isOwnAddition && node.deletion) {
      run ??= { startLine: line, endLine: line, afterIndex: anchorIndex, deletions: new Map() };
      run.endLine = line;
      run.deletions.set(node.deletion.sessionId, Math.max(node.deletion.step, run.deletions.get(node.deletion.sessionId) ?? -1));
      continue;
    }
    closeRun(index);
    anchorIndex = index;
  }
  closeRun(nodes.length);
  return overwrites;
}

/**
 * The file as only the own session changed it: `base` with the line changes of every step of `versions` (oldest first)
 * whose session `isOwn` accepts, then `current`. Lines other sessions added are left out and lines they deleted are
 * kept; the step from the last version to `current` and every step without a session count as someone else's. Own
 * lines that are no longer on disk are listed in `overwrites`.
 */
export function ownView(base: string | null, versions: FileVersion[], current: string | null, isOwn: (sessionId: string) => boolean): OwnView {
  let nodes: LineNode[] = splitLines(base ?? "").map((text) => ({ text, isOwnOrigin: true, isOwnAddition: false, isAlive: true, isDeletedByOwn: false, deletion: null }));
  const steps = [...versions, { sessionId: null, content: current }];
  for (let index = 0; index < steps.length; index++) {
    const { sessionId, content } = steps[index];
    nodes = applyStep(nodes, splitLines(content ?? ""), { index, sessionId, isOwn: !!sessionId && isOwn(sessionId) });
  }
  return { content: joinLines(nodes.filter(isShown).map((node) => node.text)), overwrites: collectOverwrites(nodes) };
}
