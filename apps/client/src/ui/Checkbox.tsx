import { useEffect, useRef } from "react";

export type CheckState = "checked" | "unchecked" | "mixed";

/** Native checkbox that also renders the indeterminate state; clicks never bubble to the row behind it. */
export function Checkbox({ state, onChange, title }: { state: CheckState; onChange: () => void; title?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = state === "mixed";
    }
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === "checked"}
      onChange={onChange}
      onClick={(event) => event.stopPropagation()}
      title={title}
      className="hunt-checkbox"
    />
  );
}
