import type { ReactNode } from "react";
import { CommentIcon } from "../../ui/Icons";

/**
 * An annotation of the review widget as a chip: a thumbnail of the element's screenshot (else a comment icon), the
 * comment and a short name of the element. The composer passes `children` for its remove button; a sent prompt's bubble
 * shows the chip as is.
 */
export function AnnotationChip({ comment, label, title, imageUrl, children }: { comment: string; label: string; title: string; imageUrl?: string; children?: ReactNode }) {
  return (
    <span className="group relative flex h-7 max-w-80 items-center gap-1.5 rounded-md border border-white/10 bg-black/30 px-2 text-[12px]" title={title}>
      {imageUrl ? (
        <img src={imageUrl} alt="" className="-ml-1 size-5 shrink-0 rounded-sm border border-white/10 object-cover" />
      ) : (
        <CommentIcon className="size-3 shrink-0 text-neutral-400" />
      )}
      <span className="min-w-0 truncate text-neutral-200">{comment}</span>
      <span className="max-w-48 shrink-0 truncate text-neutral-500">{label}</span>
      {children}
    </span>
  );
}
