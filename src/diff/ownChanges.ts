import { diffArrays } from "diff";
import type { FileVersion } from "../ipc/types";

/** A line that existed at some point of a file's history; deleted lines stay in place as tombstones. */
type LineNode = {
  text: string;
  /** The line is in the base version or was added by the own session. */
  isOwnOrigin: boolean;
  isAlive: boolean;
  isDeletedByOwn: boolean;
};

/** Lines of `text` with their line breaks; a last line without a break is kept as is. */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function joinLines(lines: string[]): string {
  return lines.map((line, index) => (index < lines.length - 1 && !line.endsWith("\n") ? `${line}\n` : line)).join("");
}

/** Applies one version step to the line history: removed lines become tombstones, added lines are inserted after them. */
function applyStep(nodes: LineNode[], nextLines: string[], isOwnStep: boolean): LineNode[] {
  const alive = nodes.filter((node) => node.isAlive);
  const result: LineNode[] = [];
  let aliveIndex = 0;
  let nodeIndex = 0;
  for (const part of diffArrays(alive.map((node) => node.text), nextLines)) {
    if (part.added) {
      for (const text of part.value) {
        result.push({ text, isOwnOrigin: isOwnStep, isAlive: true, isDeletedByOwn: false });
      }
      continue;
    }
    for (let count = 0; count < part.value.length; count++) {
      const node = alive[aliveIndex++];
      while (nodes[nodeIndex] !== node) {
        result.push(nodes[nodeIndex++]);
      }
      nodeIndex++;
      result.push(part.removed ? { ...node, isAlive: false, isDeletedByOwn: isOwnStep } : node);
    }
  }
  return result.concat(nodes.slice(nodeIndex));
}

/**
 * The file as only the own session changed it: `base` with the line changes of every step of `versions` (oldest first)
 * whose session `isOwn` accepts, then `current`. Lines other sessions added are left out and lines they deleted are
 * kept; the step from the last version to `current` and every step without a session count as someone else's.
 */
export function ownContent(base: string | null, versions: FileVersion[], current: string | null, isOwn: (sessionId: string) => boolean): string {
  let nodes: LineNode[] = splitLines(base ?? "").map((text) => ({ text, isOwnOrigin: true, isAlive: true, isDeletedByOwn: false }));
  for (const step of [...versions, { sessionId: null, content: current }]) {
    nodes = applyStep(nodes, splitLines(step.content ?? ""), !!step.sessionId && isOwn(step.sessionId));
  }
  return joinLines(nodes.filter((node) => node.isOwnOrigin && !node.isDeletedByOwn).map((node) => node.text));
}
