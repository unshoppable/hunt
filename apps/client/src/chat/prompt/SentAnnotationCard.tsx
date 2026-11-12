import { CommentIcon } from "../../ui/Icons";
import { ChatImages } from "../ChatImages";
import type { SentAnnotation } from "./annotation-prompt.utils";

/**
 * An annotation of the review widget in the bubble of the prompt that sent it: the screenshot of the element (a click
 * shows it full size), below it the whole comment and a short name of the element. Without a screenshot a comment icon
 * stands in for it.
 */
export function SentAnnotationCard({ annotation, imageUrl }: { annotation: SentAnnotation; imageUrl?: string }) {
  return (
    <div className="max-w-full rounded-md border border-white/10 bg-black/30 p-2" title={annotation.page}>
      {imageUrl ? <ChatImages urls={[imageUrl]} className="mb-2" /> : null}
      <div className="flex items-start gap-1.5">
        {imageUrl ? null : <CommentIcon className="mt-1 size-3 shrink-0 text-neutral-400" />}
        <span className="min-w-0 whitespace-pre-wrap break-words text-neutral-200">{annotation.comment}</span>
      </div>
      <div className="mt-0.5 truncate text-[12px] text-neutral-500">{annotation.label}</div>
    </div>
  );
}
