import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { commands } from "../ipc/commands";
import type { PullRequestDetails } from "../ipc/types";
import { useHuntStore } from "../state/store";
import { MarkdownText } from "../chat/MessageList";
import { formatRelativeTime } from "../chat/ScreenshotPicker";
import { SECONDARY_BUTTON_SM } from "../ui/buttons";
import { ExternalIcon, GitHubIcon } from "../ui/icons";
import { errorText, useLoad } from "../ui/useLoad";
import { REVIEW_STATE_LABELS, buildTimeline, type TimelineEntry } from "./timeline";

/** Badge colors of a pull request state as GitHub shows them: green open, purple merged, red closed, grey draft. */
const STATE_BADGES: Record<string, { label: string; className: string }> = {
  OPEN: { label: "Open", className: "bg-emerald-600 text-white" },
  MERGED: { label: "Merged", className: "bg-purple-600 text-white" },
  CLOSED: { label: "Closed", className: "bg-red-600 text-white" },
  DRAFT: { label: "Draft", className: "bg-neutral-600 text-white" },
};

/** Marker next to a review's state line: a check for approval, a cross for requested changes, an eye otherwise. */
const REVIEW_MARKS: Record<string, { mark: string; className: string }> = {
  APPROVED: { mark: "✓", className: "bg-emerald-600 text-white" },
  CHANGES_REQUESTED: { mark: "×", className: "bg-red-600 text-white" },
};

/**
 * The "PR Description" tab: the description of the pull request the session reviews followed by its conversation,
 * laid out like GitHub's conversation view. Loads once per session; a session without a pull request says so.
 */
export function PullRequestPanel({ sessionId }: { sessionId: string }) {
  const pullRequest = useHuntStore((state) => state.sessions.find((session) => session.id === sessionId)?.pullRequest ?? null);
  const [details, setDetails] = useState<PullRequestDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useLoad(() => commands.viewPullRequest(sessionId), { onValue: setDetails, onError: (reason) => setError(errorText(reason)) }, [sessionId], {
    isEnabled: !!pullRequest,
  });

  if (!pullRequest) {
    return <EmptyState>This session does not review a pull request. Start a session from “PR review” to see its description here.</EmptyState>;
  }
  if (error) {
    return (
      <div className="p-6">
        <p className="rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-[14px] text-red-300 break-words">{error}</p>
      </div>
    );
  }
  if (!details) {
    return <EmptyState>Loading pull request #{pullRequest.number}…</EmptyState>;
  }

  const badge = STATE_BADGES[details.isDraft && details.state === "OPEN" ? "DRAFT" : details.state] ?? STATE_BADGES.OPEN;
  const timeline = buildTimeline(details);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[860px] flex-col gap-4 px-6 py-5 text-[14px] leading-[1.6]">
        <header className="flex flex-col gap-2 border-b border-(--line) pb-4">
          <div className="flex items-start gap-3">
            <h2 className="min-w-0 flex-1 text-[26px] leading-tight font-semibold text-neutral-100 break-words">
              {details.title} <span className="font-normal text-neutral-500">#{details.number}</span>
            </h2>
            <button type="button" onClick={() => void openUrl(details.url)} className={`${SECONDARY_BUTTON_SM} shrink-0`} title="Open on GitHub">
              <GitHubIcon className="size-4" />
              Open on GitHub
              <ExternalIcon className="size-3" />
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[14px] text-neutral-400">
            <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-medium ${badge.className}`}>{badge.label}</span>
            <span>
              <span className="font-medium text-neutral-200">{details.author}</span> wants to merge into{" "}
              <code className="rounded bg-white/8 px-1.5 py-0.5 font-mono text-[12px] text-sky-300">{details.baseRefName}</code> from{" "}
              <code className="rounded bg-white/8 px-1.5 py-0.5 font-mono text-[12px] text-sky-300">{details.headRefName}</code>
            </span>
          </div>
        </header>

        <CommentCard author={details.author} at={details.createdAt} verb="opened this pull request" body={details.body} emptyText="No description provided." isAuthor />

        {timeline.map((entry, index) => (
          <TimelineRow key={index} entry={entry} pullRequestAuthor={details.author} />
        ))}
      </div>
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center px-8 text-center text-[14px] text-neutral-500">{children}</div>;
}

/** One conversation entry: a comment card, or a review's state line with its summary card when it has text. */
function TimelineRow({ entry, pullRequestAuthor }: { entry: TimelineEntry; pullRequestAuthor: string }) {
  if (entry.kind === "comment") {
    return (
      <CommentCard
        author={entry.comment.author}
        at={entry.comment.createdAt}
        verb="commented"
        body={entry.comment.body}
        url={entry.comment.url}
        isAuthor={entry.comment.author === pullRequestAuthor}
      />
    );
  }
  const { review } = entry;
  const mark = REVIEW_MARKS[review.state];
  const label = REVIEW_STATE_LABELS[review.state] ?? review.state.toLowerCase().replace(/_/g, " ");
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 pl-1 text-[14px] text-neutral-400">
        {mark ? (
          <span className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[12px] font-bold ${mark.className}`}>{mark.mark}</span>
        ) : (
          <Avatar login={review.author} size="size-5" />
        )}
        <span>
          <span className="font-medium text-neutral-200">{review.author}</span> {label}
          {review.submittedAt ? <span className="text-neutral-500"> · {formatRelativeTime(Date.parse(review.submittedAt))}</span> : null}
        </span>
      </div>
      {review.body.trim() ? (
        <div className="ml-7">
          <CommentCard author={review.author} at={review.submittedAt} verb="left a review" body={review.body} isAuthor={review.author === pullRequestAuthor} />
        </div>
      ) : null}
    </div>
  );
}

/** A GitHub-style comment: avatar beside a bordered card with the author line on a tinted header and the markdown body. */
function CommentCard({
  author,
  at,
  verb,
  body,
  url,
  emptyText,
  isAuthor,
}: {
  author: string;
  at: string;
  verb: string;
  body: string;
  url?: string;
  /** Shown in italics instead of an empty body. */
  emptyText?: string;
  /** The author of the pull request gets the "Author" tag like on GitHub. */
  isAuthor: boolean;
}) {
  const time = at ? formatRelativeTime(Date.parse(at)) : "";
  return (
    <div className="flex items-start gap-3">
      <Avatar login={author} size="size-8" />
      <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-(--line) bg-(--surface-inset)">
        <div className="flex items-center gap-2 border-b border-(--line) bg-white/4 px-3 py-2 text-[14px] text-neutral-400">
          <span className="min-w-0 truncate">
            <span className="font-medium text-neutral-200">{author}</span> {verb}
            {time ? <span title={at}> {time}</span> : null}
          </span>
          {isAuthor ? <span className="shrink-0 rounded-full border border-white/15 px-2 text-[11px] text-neutral-400">Author</span> : null}
          <span className="flex-1" />
          {url ? (
            <button type="button" onClick={() => void openUrl(url)} className="shrink-0 text-neutral-500 hover:text-white" title="Open comment on GitHub" aria-label="Open comment on GitHub">
              <ExternalIcon className="size-3.5" />
            </button>
          ) : null}
        </div>
        <div className="px-4 py-3">
          {body.trim() ? <MarkdownText text={body} className="markdown-document" /> : <p className="text-neutral-500 italic">{emptyText ?? "No text."}</p>}
        </div>
      </div>
    </div>
  );
}

/** GitHub avatar of a login; the first letter stands in while it loads or when it cannot be fetched (bots, offline). */
function Avatar({ login, size }: { login: string; size: string }) {
  const [hasFailed, setHasFailed] = useState(false);
  const initial = login.replace(/^app\//, "").charAt(0).toUpperCase();
  return (
    <span className={`relative flex ${size} shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-700 text-[12px] font-semibold text-neutral-200`} title={login}>
      {initial}
      {hasFailed ? null : <img src={`https://github.com/${login}.png?size=64`} alt="" onError={() => setHasFailed(true)} className="absolute inset-0 size-full object-cover" />}
    </span>
  );
}
