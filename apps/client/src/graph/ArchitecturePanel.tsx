import { useSettingsStore } from "../settings/settings.store";
import { isShapeDiagramType } from "./diagram-types.constants";
import { GraphPanel } from "./GraphPanel";
import { DiagramFilePanel } from "./shapes/DiagramFilePanel";
import { ShapeDiagramPanel } from "./shapes/ShapeDiagramPanel";

/**
 * The Architecture tab: shows the diagram file of the repository opened for the session ("Show in Architecture"), or
 * the diagram type chosen in its toolbar, the file-level dependency diagram (`GraphPanel`) or one of the shape
 * diagrams (`ShapeDiagramPanel`). Each view mounts its own panel, so switching never carries one diagram's state into
 * the other.
 */
export function ArchitecturePanel({ sessionId }: { sessionId: string }) {
  const diagramFile = useSettingsStore((state) => state.diagramFiles[sessionId]);
  const diagramType = useSettingsStore((state) => state.diagramTypes[sessionId] ?? "dependencies");
  if (diagramFile) return <DiagramFilePanel key={`file:${diagramFile}`} sessionId={sessionId} path={diagramFile} />;
  if (isShapeDiagramType(diagramType)) return <ShapeDiagramPanel key={diagramType} sessionId={sessionId} source={{ kind: "generated", type: diagramType }} />;
  return <GraphPanel key="dependencies" sessionId={sessionId} />;
}
