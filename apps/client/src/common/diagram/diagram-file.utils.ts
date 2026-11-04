/** Every diagram file ends in this suffix, the generated ones in `.hunt/diagrams/` and the ones saved into the repository. */
export const DIAGRAM_FILE_SUFFIX = ".react-flow.json";

/** True for a path the Architecture tab can show: a file ending in `DIAGRAM_FILE_SUFFIX`. */
export function isDiagramFilePath(path: string): boolean {
  return path.endsWith(DIAGRAM_FILE_SUFFIX) && path.length > DIAGRAM_FILE_SUFFIX.length;
}
