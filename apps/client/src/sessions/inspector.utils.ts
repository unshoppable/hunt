import type { RightTab } from "./inspector.store";

/** What decides which tabs the inspector of a session has besides the ones every session has. */
export type InspectorTabConditions = { isOnVm: boolean; isReviewingPullRequest: boolean; isFactory: boolean };

/**
 * Whether the inspector of a session has `tab`: Preview and Desktop only for a session on a VM, PR Description only for a
 * pull request review, Factory only for a session of the swf poller (`mode === "swf"`).
 */
export function hasInspectorTab(tab: RightTab, { isOnVm, isReviewingPullRequest, isFactory }: InspectorTabConditions): boolean {
  if (tab === "preview" || tab === "desktop") return isOnVm;
  if (tab === "pullRequest") return isReviewingPullRequest;
  if (tab === "factory") return isFactory;
  return true;
}
