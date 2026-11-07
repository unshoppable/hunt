import { diagramRunKey, isDiagramFilePath } from "../common/diagram/diagram-file.utils";
import type { DiagramType, ReviewLevel } from "../common/diagram/diagram.types";
import type { GraphStatus } from "../graph/graph.types";
import type { ShapeDiagram } from "../graph/shapes/shape-diagram.types";
import { parseShapeDiagram, shapeDiagramTypeOf } from "../graph/shapes/shape-schema.utils";
import { commands } from "../ipc/commands";
import { useHuntStore } from "../sessions/hunt.store";
import { useSessionViewStore } from "../sessions/inspector.store";
import type { SessionView } from "../sessions/session.types";
import { useSettingsStore, type GraphFilter } from "../settings/settings.store";
import { errorText } from "../ui/error-text.utils";
import { erdTables, unchangedTableIds, unknownTableIds } from "./graph-commands.utils";
import type { GraphAction } from "./tab-commands.utils";
import { localWorktreePaths } from "./worktree-paths.utils";

/**
 * The diagram the Architecture tab of a session shows: a diagram file of the repository (worktree-relative `file`) with
 * the shape diagram type its content declares (null for none), or the generated diagram of the type picked in its
 * toolbar. `content` is the file's content or, for a generated ERD, the generated file's; null when there is none.
 */
type ShownDiagram = { file: string | null; type: DiagramType | null; content: unknown };

/** The diagram the Architecture tab of `sessionId` shows; throws when its repository file cannot be read or holds no JSON. */
async function readShownDiagram(sessionId: string): Promise<ShownDiagram> {
  const { diagramFiles, diagramTypes } = useSettingsStore.getState();
  const file = diagramFiles[sessionId] ?? null;
  if (!file) {
    const type = diagramTypes[sessionId] ?? "dependencies";
    return { file, type, content: type === "erd" ? await commands.readGraph(sessionId, type) : null };
  }
  const text = await commands.readFile(sessionId, file).catch((reason: unknown) => {
    throw new Error(`reading ${file} failed: ${errorText(reason)}`);
  });
  let content: unknown;
  try {
    content = JSON.parse(text);
  } catch (reason) {
    throw new Error(`${file} is not valid JSON: ${errorText(reason)}`);
  }
  return { file, type: shapeDiagramTypeOf(content), content };
}

/** The ERD the Architecture tab of `sessionId` shows; throws when it shows another diagram or the ERD has not been generated. */
async function readShownErd(sessionId: string): Promise<ShapeDiagram> {
  const shown = await readShownDiagram(sessionId);
  if (shown.type !== "erd") throw new Error(`the Architecture tab shows ${shown.file ?? `the ${shown.type} diagram`}, not an ERD`);
  if (shown.content === null || shown.content === undefined) throw new Error("the ERD has not been generated yet");
  return parseShapeDiagram(shown.content, "erd", shown.file ?? undefined).diagram;
}

/** When the shown diagram was generated and whether files changed since; null when that cannot be read. */
function readStatus(sessionId: string, shown: Pick<ShownDiagram, "file" | "type">): Promise<GraphStatus | null> {
  if (shown.file) return commands.diagramFileStatus(sessionId, shown.file).catch(() => null);
  return shown.type ? commands.graphStatus(sessionId, shown.type).catch(() => null) : Promise.resolve(null);
}

/**
 * The Architecture tab of `session` as `hunt-client graph` prints it: the shown diagram's `type` and repository `file`
 * (worktree-relative, null for a generated diagram), whether it is being generated and why its last generation failed,
 * its `status`, the hidden ERD tables, the files the dependency graph excludes and its filter; for an ERD also its
 * `tables` with their change marks (null while it is not generated), and `readError` when the shown file cannot be read.
 */
async function readGraphState(session: SessionView): Promise<unknown> {
  const settings = useSettingsStore.getState();
  const file = settings.diagramFiles[session.id] ?? null;
  const runKey = diagramRunKey(settings.diagramTypes[session.id] ?? "dependencies", file);
  const chat = useHuntStore.getState().chats[session.id];
  const shown = await readShownDiagram(session.id).catch((reason: unknown) => new Error(errorText(reason)));
  const type = shown instanceof Error ? null : shown.type;
  const isErdShown = type === "erd" && !(shown instanceof Error);
  return {
    type,
    file,
    isGenerating: chat?.generatingDiagrams.includes(runKey) ?? false,
    error: chat?.diagramErrors[runKey] ?? null,
    status: await readStatus(session.id, { file, type }),
    ...(isErdShown ? { tables: shown.content ? erdTables(parseShapeDiagram(shown.content, "erd", file ?? undefined).diagram) : null } : {}),
    hiddenTables: settings.erdHiddenTables[session.id] ?? [],
    excludedFiles: settings.graphExcludedFiles[session.id] ?? [],
    filter: settings.graphFilter,
    ...(shown instanceof Error ? { readError: shown.message } : {}),
  };
}

/** Runs `action` on the Graph tab of `session` and shows that tab; without an action resolves to the tab's state, as `hunt-client graph` prints it. */
export async function runGraphCommand(session: SessionView, action: GraphAction | undefined): Promise<unknown> {
  if (!action) return readGraphState(session);
  const settings = useSettingsStore.getState();
  switch (action.name) {
    case "type":
      settings.setDiagramType(session.id, action.type);
      break;
    case "file": {
      const [path = null] = localWorktreePaths(session, action.path ? [action.path] : []);
      if (path && !isDiagramFilePath(path)) throw new Error(`${path} is no diagram file: its name must end in .react-flow.json`);
      settings.setDiagramFile(session.id, path);
      break;
    }
    case "tables": {
      const diagram = await readShownErd(session.id);
      const unknown = unknownTableIds(diagram, action.hide);
      if (unknown.length) throw new Error(`the ERD has no table ${unknown.join(", ")}`);
      settings.setErdHiddenTables(session.id, action.hide);
      break;
    }
    case "changedTables":
      settings.setErdHiddenTables(session.id, unchangedTableIds(await readShownErd(session.id)));
      break;
    case "files":
      settings.setGraphExcludedFiles(session.id, localWorktreePaths(session, action.exclude));
      break;
    case "filter": {
      const patch: Partial<GraphFilter> = {};
      if (action.minReview !== undefined) {
        // The action's rule allows the integers 1 to 4 only.
        patch.minReview = action.minReview as ReviewLevel;
      }
      if (action.hiddenGlobs !== undefined) {
        patch.hiddenGlobs = action.hiddenGlobs;
      }
      settings.setGraphFilter(patch);
      break;
    }
    case "generate": {
      // A diagram file of the repository is rewritten from the files it was derived from, as its Generate button does.
      const shown = await readShownDiagram(session.id);
      if (!shown.type) throw new Error(`${shown.file} declares no shape diagram type in \`type\``);
      const runKey = diagramRunKey(shown.type, shown.file);
      const chat = useHuntStore.getState().chats[session.id];
      if (chat?.move) throw new Error("the session is moving to or from its VM");
      if (chat?.generatingDiagrams.includes(runKey)) throw new Error(`the ${runKey} diagram is being generated already`);
      void useHuntStore.getState().refreshGraph(session.id, shown.type, action.instructions ?? "", shown.file);
      break;
    }
  }
  useSessionViewStore.getState().setTab(session.id, "graph");
}
