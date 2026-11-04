import { useState } from "react";
import type { ShapeDiagramType } from "../../common/diagram/diagram.types";
import { commands } from "../../ipc/commands";
import { useHuntStore } from "../../sessions/hunt.store";
import { useSettingsStore } from "../../settings/settings.store";
import { SECONDARY_BUTTON_XS } from "../../ui/buttons.constants";
import { errorText } from "../../ui/error-text.utils";
import { useLoad } from "../../ui/load.hook";
import { DiagramTypeDropdown } from "../DiagramToolbar";
import { shapeDiagramTypeOf } from "./shape-schema.utils";
import { ShapeDiagramPanel } from "./ShapeDiagramPanel";

/**
 * A diagram file of the repository in the Architecture tab: reads which shape diagram the file declares in `type` and
 * shows it editable in `ShapeDiagramPanel`, or explains why it cannot (a missing file, no JSON, or a dependency graph
 * or other content without a shape diagram type) with a way back to the generated diagrams.
 */
export function DiagramFilePanel({ sessionId, path }: { sessionId: string; path: string }) {
  const editVersion = useHuntStore((state) => state.chats[sessionId]?.editVersion ?? 0);
  const setDiagramFile = useSettingsStore((state) => state.setDiagramFile);
  const [diagramType, setDiagramType] = useState<ShapeDiagramType | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useLoad(
    () => commands.readFile(sessionId, path),
    {
      onValue: (content) => {
        try {
          const type = shapeDiagramTypeOf(JSON.parse(content));
          setDiagramType(type);
          setError(type ? null : `${path} declares no shape diagram type (c4-context, c4-container, states, erd or process) in \`type\`.`);
        } catch (reason) {
          setDiagramType(null);
          setError(`${path} is not valid JSON: ${errorText(reason)}`);
        }
      },
      onError: (reason) => {
        setDiagramType(null);
        setError(`Reading ${path} failed: ${errorText(reason)}`);
      },
    },
    [sessionId, path, editVersion],
  );

  if (diagramType) return <ShapeDiagramPanel key={diagramType} sessionId={sessionId} source={{ kind: "file", path, type: diagramType }} />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-(--line) px-3 py-2.5 text-[13px]">
        <DiagramTypeDropdown sessionId={sessionId} />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-neutral-500">{path}</span>
      </div>
      {error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-neutral-400">
          <p>{error}</p>
          <button type="button" onClick={() => setDiagramFile(sessionId, null)} className={SECONDARY_BUTTON_XS}>
            Back to the generated diagrams
          </button>
        </div>
      ) : null}
    </div>
  );
}
