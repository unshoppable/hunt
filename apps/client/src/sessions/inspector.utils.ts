import type { RightTab } from "./inspector.store";

/** What decides which tabs the inspector of a session has besides the ones every session has. */
export type InspectorTabConditions = { isOnVm: boolean; isReviewingPullRequest: boolean };

/** Whether the inspector of a session has `tab`: Preview and Desktop only for a session on a VM, PR Description only for a pull request review. */
export function hasInspectorTab(tab: RightTab, { isOnVm, isReviewingPullRequest }: InspectorTabConditions): boolean {
  if (tab === "preview" || tab === "desktop") return isOnVm;
  if (tab === "pullRequest") return isReviewingPullRequest;
  return true;
}
