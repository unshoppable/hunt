import { useState } from "react";
import { commands } from "../ipc/commands";
import type { ReviewEvent } from "../ipc/types";
import { INPUT } from "./styles";
import { GHOST_BUTTON, PRIMARY_BUTTON } from "../ui/buttons";
import { Modal } from "../ui/Modal";

/** GitHub's three review verdicts, in the order its own review dialog lists them. */
const EVENTS: { id: ReviewEvent; label: string; hint: string }[] = [
  { id: "comment", label: "Comment", hint: "General feedback without explicit approval" },
  { id: "approve", label: "Approve", hint: "Feedback and approval of merging these changes" },
  { id: "requestChanges", label: "Request changes", hint: "Feedback that must be addressed before merging" },
];

/**
 * Submits a review of pull request `pullRequestNumber`: a summary comment with one of GitHub's verdicts, plus the
 * `draftCount` comments drafted on lines of the files. Without drafts only an approval may go without a comment,
 * as on GitHub.
 */
export function ReviewDialog({
  sessionId,
  pullRequestNumber,
  draftCount,
  onClose,
  onSubmitted,
}: {
  sessionId: string;
  pullRequestNumber: number;
  /** Review comments drafted under lines of the files; they go out with the review. */
  draftCount: number;
  onClose: () => void;
  /** Called once GitHub accepted the review, right before the dialog closes. */
  onSubmitted: () => void;
}) {
  const [body, setBody] = useState("");
  const [event, setEvent] = useState<ReviewEvent>("comment");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = (body.trim().length > 0 || event === "approve" || draftCount > 0) && !isSubmitting;

  async function submit() {
    if (!canSubmit) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await commands.submitPullRequestReview(sessionId, event, body.trim());
    } catch (reason) {
      setError(String(reason));
      setIsSubmitting(false);
      return;
    }
    onSubmitted();
    onClose();
  }

  return (
    <Modal label="Submit review" onClose={onClose} isCloseable={!isSubmitting} className="w-[520px] bg-(--surface-chat) p-4">
      <h2 className="mb-1 text-base font-semibold">Submit review</h2>
      <p className="mb-3 text-[13px] text-neutral-400">
        Pull request #{pullRequestNumber}
        {draftCount ? ` · ${draftCount} drafted ${draftCount === 1 ? "comment goes" : "comments go"} out with this review: inline on diff lines, as notes in the summary elsewhere.` : ""}
      </p>
      <label className="mb-1 block text-[13px] text-neutral-400">Comment</label>
      <textarea
        value={body}
        onChange={(changeEvent) => setBody(changeEvent.target.value)}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key === "Enter" && (keyEvent.metaKey || keyEvent.ctrlKey)) {
            keyEvent.preventDefault();
            void submit();
          }
        }}
        placeholder={draftCount ? "Summarize your review (optional)" : "Leave a comment"}
        autoFocus
        rows={5}
        className={`${INPUT} mb-3 resize-y`}
      />
      <fieldset className="mb-3 flex flex-col gap-1.5">
        {EVENTS.map((option) => (
          <label key={option.id} className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-(--row-hover)">
            <input type="radio" name="review-event" value={option.id} checked={event === option.id} onChange={() => setEvent(option.id)} className="mt-1 accent-blue-500" />
            <span className="flex flex-col">
              <span className="text-[13px] text-neutral-100">{option.label}</span>
              <span className="text-[12px] text-neutral-500">{option.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {error ? <p className="mb-3 whitespace-pre-wrap text-[13px] text-red-400">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={isSubmitting} className={GHOST_BUTTON}>
          Cancel
        </button>
        <button type="button" onClick={() => void submit()} disabled={!canSubmit} className={PRIMARY_BUTTON} title="⌘⏎">
          {isSubmitting ? "Submitting…" : "Submit review"}
        </button>
      </div>
    </Modal>
  );
}
