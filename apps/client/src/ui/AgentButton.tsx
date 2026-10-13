import type { ButtonHTMLAttributes, CSSProperties, Ref } from "react";

interface AgentButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  ref?: Ref<HTMLButtonElement>;
  /** Lets the button's glow breathe while the agent it stands for is running a turn. */
  isBusy?: boolean;
  /** Edge length of the square surface in px. */
  size?: number;
  /** Edge length of the sparkle in px. */
  sparkleSize?: number;
  /** Text right of the sparkle; hide it with `labelClassName` (e.g. a container query) to fall back to the square. */
  label?: string;
  labelClassName?: string;
}

/**
 * Square button with the agent sparkle (the `.hunt-agent-button` of index.css), the control that opens or shows the
 * agent's chat about a file or selection; callers pass `title` and `aria-label`, since the optional label may be hidden.
 */
export function AgentButton({ isBusy = false, size = 22, sparkleSize = 15, label, labelClassName = "", className = "", style, ...props }: AgentButtonProps) {
  const sizing = { "--agent-button-size": `${size}px`, "--agent-sparkle-size": `${sparkleSize}px`, ...style } as CSSProperties;
  return (
    <button type="button" className={`hunt-agent-button ${label ? "hunt-agent-button-labelled" : ""} ${isBusy ? "hunt-agent-button-busy" : ""} ${className}`} style={sizing} {...props}>
      {label ? <span className={`hunt-agent-button-label ${labelClassName}`}>{label}</span> : null}
    </button>
  );
}
