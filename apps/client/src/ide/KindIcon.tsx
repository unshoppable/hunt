/** Letter and color of the badge for a TypeScript element kind, after WebStorm's symbol icons. */
const KIND_BADGES: Record<string, { letter: string; color: string }> = {
  class: { letter: "C", color: "#3574f0" },
  "local class": { letter: "C", color: "#3574f0" },
  interface: { letter: "I", color: "#5fb865" },
  type: { letter: "T", color: "#5fb865" },
  enum: { letter: "E", color: "#3574f0" },
  "enum member": { letter: "e", color: "#3574f0" },
  function: { letter: "f", color: "#9a7dff" },
  "local function": { letter: "f", color: "#9a7dff" },
  method: { letter: "m", color: "#9a7dff" },
  constructor: { letter: "m", color: "#9a7dff" },
  getter: { letter: "m", color: "#9a7dff" },
  setter: { letter: "m", color: "#9a7dff" },
  property: { letter: "f", color: "#e38c2d" },
  const: { letter: "v", color: "#e38c2d" },
  let: { letter: "v", color: "#e38c2d" },
  var: { letter: "v", color: "#e38c2d" },
  "local var": { letter: "v", color: "#e38c2d" },
  parameter: { letter: "p", color: "#e38c2d" },
  module: { letter: "M", color: "#8790a5" },
};

/** Letters whose ink reaches the ascender line; the others only fill the x-height and sit on a higher baseline. */
const ASCENDER_LETTERS = /^[A-Zbdfhklt]$/;

/**
 * Baselines that center the letter's ink on the circle (cy = 8) at 10px: cap height and the ascender are ~7.2px,
 * the x-height ~5.5px, so a lowercase "m" on the capital's baseline would hang 1px low.
 */
const BASELINE = { ascender: 11.6, xHeight: 10.7 };

/** A round badge naming a symbol's kind (blue "C" for a class, purple "m" for a method), like WebStorm's symbol icons. */
export function KindIcon({ kind, className = "size-4" }: { kind: string; className?: string }) {
  const badge = KIND_BADGES[kind] ?? { letter: "·", color: "#8790a5" };
  const baseline = ASCENDER_LETTERS.test(badge.letter) ? BASELINE.ascender : BASELINE.xHeight;
  return (
    <svg viewBox="0 0 16 16" className={`shrink-0 ${className}`} aria-hidden="true" data-kind={kind}>
      <circle cx="8" cy="8" r="7" fill={badge.color} />
      <text x="8" y={baseline} textAnchor="middle" fontSize="10" fontWeight="600" fontFamily="ui-sans-serif, system-ui, sans-serif" fill="#ffffff">
        {badge.letter}
      </text>
    </svg>
  );
}
