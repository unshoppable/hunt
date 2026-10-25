import { Fragment } from "react";
import { Group } from "react-resizable-panels";
import { PaneSeparator, Panel } from "../layout/ResizablePanes";
import type { Workspace } from "./documents";
import { EditorPane } from "./EditorPane";
import type { IdeSession } from "./ideStore";
import type { SelectionRequest } from "../diff/selectionContext";

type EditorGridProps = {
  sessionId: string;
  workspace: Workspace;
  ide: IdeSession;
  /** Files with unsaved edits. */
  dirtyPaths: readonly string[];
  /** Git status letter of each changed file; it colors the tab's name. */
  statusByPath: Readonly<Record<string, string>>;
  /** Opens the sub chat popover for a selection or, with `subSessionId`, an existing sub chat (see EditorPane.tsx). */
  onOpenSubChat?: (request: SelectionRequest, subSessionId?: string) => void;
  /** Opens or closes the sub chat popover from the selection's floating button (see EditorPane.tsx). */
  onToggleSubChat?: (request: SelectionRequest) => void;
};

/** The editor area: rows of panes, each resizable; empty until the first file is opened. */
export function EditorGrid({ sessionId, workspace, ide, dirtyPaths, statusByPath, onOpenSubChat, onToggleSubChat }: EditorGridProps) {
  if (!ide.layout.rows.length) {
    return (
      <div className="flex flex-1 items-center justify-center bg-(--diff-bg) text-[13px] text-neutral-500">
        Open a file from the project tree, or ⌘click a position in the diff.
      </div>
    );
  }

  return (
    <Group id={`ide-rows:${sessionId}`} orientation="vertical" className="flex-1">
      {ide.layout.rows.map((row, rowIndex) => (
        <Fragment key={row.id}>
          {rowIndex > 0 ? <PaneSeparator orientation="vertical" /> : null}
          <Panel id={row.id} minSize={120} className="flex">
            <Group id={row.id} orientation="horizontal" className="flex-1">
              {row.panes.map((pane, paneIndex) => (
                <Fragment key={pane.id}>
                  {paneIndex > 0 ? <PaneSeparator /> : null}
                  <Panel id={pane.id} minSize={200} className="flex">
                    <EditorPane
                      sessionId={sessionId}
                      workspace={workspace}
                      pane={pane}
                      isActive={pane.id === ide.activePaneId}
                      dirtyPaths={dirtyPaths}
                      statusByPath={statusByPath}
                      pendingPosition={ide.pendingPosition}
                      onOpenSubChat={onOpenSubChat}
                      onToggleSubChat={onToggleSubChat}
                    />
                  </Panel>
                </Fragment>
              ))}
            </Group>
          </Panel>
        </Fragment>
      ))}
    </Group>
  );
}
