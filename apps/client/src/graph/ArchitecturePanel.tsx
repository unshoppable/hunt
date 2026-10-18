import { useSettingsStore } from "../state/settings";
import { isShapeDiagramType } from "./diagramTypes";
import { GraphPanel } from "./GraphPanel";
import { ShapeDiagramPanel } from "./ShapeDiagramPanel";

/**
 * The Architecture tab: shows the diagram type chosen for the session in its toolbar, the file-level dependency
 * diagram (`GraphPanel`) or one of the shape diagrams (`ShapeDiagramPanel`). Each type mounts its own panel, so
 * switching never carries one diagram's state into the other.
 */
export function ArchitecturePanel({ sessionId }: { sessionId: string }) {
  const diagramType = useSettingsStore((state) => state.diagramTypes[sessionId] ?? "dependencies");
  if (isShapeDiagramType(diagramType)) return <ShapeDiagramPanel key={diagramType} sessionId={sessionId} diagramType={diagramType} />;
  return <GraphPanel key="dependencies" sessionId={sessionId} />;
}
