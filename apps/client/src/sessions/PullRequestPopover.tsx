import { useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { commands } from "../ipc/commands";
import type { CheckSummary, PullRequest, PullRequestLabel, ViewerReview } from "../ipc/types";
import { formatRelativeTime } from "../chat/ScreenshotPicker";
import { SearchField } from "../ui/SearchField";
import { CheckIcon, CloseIcon, CommentIcon, ExternalIcon } from "../ui/icons";
import { ResizeGrips } from "../ui/ResizeGrips";
import { useDismiss } from "../ui/useDismiss";
import { errorText, useLoad } from "../ui/useLoad";
import { usePopupSize } from "../ui/usePopupSize";
import { useViewportSize } from "../ui/useViewportSize";
import { filterPullRequests } from "./pullRequests";

type PullRequestPopoverProps = {
  /** Repository whose GitHub remote is asked for its open pull requests. */
  repoPath: string;
  /** The button that opened the popover; pressing it again closes without reopening. */
  anchorRef: RefObject<Element | null>;
  onSelect: (pullRequest: PullRequest) => void;
  onClose: () => void;
};

/** The chip that marks the signed-in user's part in a pull request's review. */
const VIEWER_REVIEW_CHIPS: Record<ViewerReview, { label: string; className: string; icon?: ReactNode }> = {
  requested: { label: "Review requested", className: "border-amber-400/40 bg-amber-400/10 text-amber-300" },
  approved: { label: "You approved", className: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300" },
  changesRequested: { label: "You requested changes", className: "border-red-400/40 bg-red-400/10 text-red-300" },
  commented: { label: "Reviewed", className: "border-sky-400/40 bg-sky-400/10 text-sky-300", icon: <CheckIcon className="size-3" /> },
};

/** GitHub's overall review decision as the list words it; a required-but-missing review shows nothing, like GitHub. */
const REVIEW_DECISIONS: Record<string, { label: string; className: string }> = {
  APPROVED: { label: "Approved", className: "text-emerald-300" },
  CHANGES_REQUESTED: { label: "Changes requested", className: "text-red-300" },
};

const MIN_SIZE = { width: 420, height: 200 };
/** Space the popover keeps from the window's edges. */
const MARGIN = 16;

/**
 * Anchored list of the repository's open pull requests, filtered by a search box like the session sidebar's. Each
 * row carries the metadata GitHub's own list shows (labels, review state, tasks, checks, comments) and marks
 * whether the signed-in user already reviewed it. Loads once when shown; a row hands its pull request to
 * `onSelect`, the arrow at its end opens it on GitHub. It hangs below its button's right edge and is as tall as
 * its rows up to the remembered height; dragging its left or bottom edge resizes it.
 */
export function PullRequestPopover({ repoPath, anchorRef, onSelect, onClose }: PullRequestPopoverProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [pullRequests, setPullRequests] = useState<PullRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = useMemo(() => filterPullRequests(pullRequests ?? [], query), [pullRequests, query]);
  const viewport = useViewportSize();
  const { size, isHeightSet, grips } = usePopupSize("pullRequests", { min: MIN_SIZE, max: { width: viewport.width - 2 * MARGIN, height: viewport.height * 0.7 } });

  useDismiss(rootRef, onClose, { anchorRefs: [anchorRef] });
  useLoad(() => commands.listPullRequests(repoPath), { onValue: setPullRequests, onError: (reason) => setError(errorText(reason)) }, [repoPath]);

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Open pull requests"
      className="absolute top-full right-0 z-50 mt-1.5 flex max-w-[calc(100cqw-2rem)] flex-col overflow-hidden rounded-xl border border-neutral-600 bg-(--surface-chat) text-sm shadow-2xl shadow-black/50"
      style={{ width: size.width, maxHeight: size.height, height: isHeightSet ? size.height : undefined }}
    >
      <SearchField value={query} onChange={setQuery} placeholder="Search pull requests" ariaLabel="Search pull requests" autoFocus className="mx-2 mt-2 mb-2" />
      <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-x-hidden overflow-y-auto px-2 pb-2">
        {error ? <li className="rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-red-300 break-words">{error}</li> : null}
        {!error && !pullRequests ? <li className="px-2.5 py-1.5 text-[13px] text-neutral-500">Loading pull requests…</li> : null}
        {pullRequests && pullRequests.length === 0 ? <li className="px-2.5 py-1.5 text-[13px] text-neutral-500">No open pull requests</li> : null}
        {query && pullRequests && pullRequests.length > 0 && rows.length === 0 ? (
          <li className="px-2.5 py-1.5 text-[13px] text-neutral-500">No pull requests match “{query}”</li>
        ) : null}
        {rows.map((pullRequest) => (
          <li key={pullRequest.number}>
            <div className="group flex items-center rounded-lg transition-colors hover:bg-(--row-hover)">
              <button
                type="button"
                onClick={() => onSelect(pullRequest)}
                className="flex min-w-0 flex-1 flex-col items-start gap-0.5 overflow-hidden py-2 pr-1 pl-3 text-left"
              >
                <span className="flex w-full items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate font-medium text-neutral-100">{pullRequest.title}</span>
                  {pullRequest.labels.map((label) => (
                    <LabelChip key={label.name} label={label} />
                  ))}
                  {pullRequest.isDraft ? <Chip className="border-white/10 text-neutral-400">Draft</Chip> : null}
                  {pullRequest.viewerReview ? (
                    <Chip className={VIEWER_REVIEW_CHIPS[pullRequest.viewerReview].className}>
                      {VIEWER_REVIEW_CHIPS[pullRequest.viewerReview].icon}
                      {VIEWER_REVIEW_CHIPS[pullRequest.viewerReview].label}
                    </Chip>
                  ) : null}
                </span>
                <MetaLine pullRequest={pullRequest} />
              </button>
              <button
                type="button"
                onClick={() => void openUrl(pullRequest.url)}
                className="mr-1 flex size-8 shrink-0 items-center justify-center rounded-md text-neutral-500 opacity-0 transition-colors group-hover:opacity-100 hover:bg-white/10 hover:text-white focus-visible:opacity-100"
                title="Open on GitHub"
                aria-label={`Open #${pullRequest.number} on GitHub`}
              >
                <ExternalIcon />
              </button>
            </div>
          </li>
        ))}
      </ul>
      <ResizeGrips edges={{ left: true, bottom: true }} {...grips} />
    </div>
  );
}

/**
 * The second line of a row: number, author, when it was opened, tasks, review decision and branch on the left;
 * diff size, checks and comment count on the right. The branch truncates first; in a narrow pane the left side is
 * clipped so the counts on the right stay visible.
 */
function MetaLine({ pullRequest }: { pullRequest: PullRequest }) {
  const decision = pullRequest.reviewDecision ? REVIEW_DECISIONS[pullRequest.reviewDecision] : undefined;
  return (
    <span className="flex w-full min-w-0 items-center gap-2 text-[12px] text-neutral-500">
      <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        <span className="shrink-0">#{pullRequest.number}</span>
        <Separator />
        <span className="shrink-0">{pullRequest.author}</span>
        <Separator />
        <span className="shrink-0" title={openedTitle(pullRequest)}>
          opened {formatRelativeTime(Date.parse(pullRequest.createdAt))}
        </span>
        {pullRequest.tasks ? (
          <>
            <Separator />
            <span className="shrink-0">
              {pullRequest.tasks.done} of {pullRequest.tasks.total} tasks
            </span>
          </>
        ) : null}
        {decision ? (
          <>
            <Separator />
            <span className={`shrink-0 ${decision.className}`}>{decision.label}</span>
          </>
        ) : null}
        <Separator />
        <span className="truncate font-mono">{pullRequest.headRefName}</span>
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <span className="font-mono" title={`${pullRequest.changedFiles} changed files`}>
          <span className="text-emerald-400">+{pullRequest.additions}</span> <span className="text-red-400">−{pullRequest.deletions}</span>
        </span>
        {pullRequest.checks ? <ChecksBadge checks={pullRequest.checks} /> : null}
        {pullRequest.commentCount > 0 ? (
          <span className="flex items-center gap-1" title={`${pullRequest.commentCount} comments`}>
            <CommentIcon className="size-3.5" />
            {pullRequest.commentCount}
          </span>
        ) : null}
      </span>
    </span>
  );
}

function openedTitle(pullRequest: PullRequest): string {
  return `Opened ${new Date(pullRequest.createdAt).toLocaleString()}, updated ${formatRelativeTime(Date.parse(pullRequest.updatedAt))}`;
}

/** Passed-of-total checks with GitHub's colouring: red once one failed, amber while one still runs, green otherwise. */
function ChecksBadge({ checks }: { checks: CheckSummary }) {
  const total = checks.passed + checks.failed + checks.pending;
  const details = [`${checks.passed} of ${total} checks passed`];
  if (checks.failed > 0) {
    details.push(`${checks.failed} failed`);
  }
  if (checks.pending > 0) {
    details.push(`${checks.pending} pending`);
  }
  return (
    <span className="flex items-center gap-1" title={details.join(", ")}>
      {checks.failed > 0 ? (
        <CloseIcon className="size-3 text-red-400" />
      ) : checks.pending > 0 ? (
        <span className="size-2 rounded-full bg-amber-400" aria-hidden="true" />
      ) : (
        <CheckIcon className="size-3.5 text-emerald-400" />
      )}
      {checks.passed}/{total}
    </span>
  );
}

function Chip({ className, children }: { className: string; children: ReactNode }) {
  return <span className={`flex shrink-0 items-center gap-1 rounded-md border px-1.5 text-[11px] whitespace-nowrap ${className}`}>{children}</span>;
}

/** A label in its GitHub colour, lightened for the text so a dark label stays readable on the dark surface. */
function LabelChip({ label }: { label: PullRequestLabel }) {
  const color = `#${label.color}`;
  return (
    <span
      className="max-w-40 min-w-0 truncate rounded-full border px-2 text-[11px]"
      style={{
        color: `color-mix(in srgb, ${color} 70%, white)`,
        borderColor: `color-mix(in srgb, ${color} 50%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
      }}
    >
      {label.name}
    </span>
  );
}

function Separator() {
  return <span className="shrink-0">·</span>;
}
