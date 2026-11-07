import type { DiagramType } from "./diagram.types";

/** Worktree-relative folder of the diagrams Hunt generates for a session (`DIAGRAMS_DIR` of `graph/graph.rs`). */
export const DIAGRAMS_DIR = ".hunt/diagrams";

/** Every diagram file ends in this suffix, the generated ones in `.hunt/diagrams/` and the ones saved into the repository. */
export const DIAGRAM_FILE_SUFFIX = ".react-flow.json";

/** True for a path the Architecture tab can show: a file ending in `DIAGRAM_FILE_SUFFIX`. */
export function isDiagramFilePath(path: string): boolean {
  return path.endsWith(DIAGRAM_FILE_SUFFIX) && path.length > DIAGRAM_FILE_SUFFIX.length;
}

/**
 * What a diagram generation runs on, to tell its spinner and error apart: the worktree-relative `file` of a copy saved
 * into the repository, or the diagram type for the session's own file.
 */
export function diagramRunKey(diagramType: DiagramType, file?: string | null): string {
  return file ?? diagramType;
}
