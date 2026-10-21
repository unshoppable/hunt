/** Blue dot behind a file name whose document has unsaved edits. */
export function UnsavedDot({ className = "" }: { className?: string }) {
  return <span className={`size-2 shrink-0 rounded-full bg-blue-400 ${className}`} title="Unsaved changes" />;
}
