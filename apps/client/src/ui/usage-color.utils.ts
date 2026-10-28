/** Catppuccin Mocha green, yellow, peach and red at the fill levels where each is pure. */
const USAGE_COLOR_STOPS: [percent: number, rgb: [number, number, number]][] = [
  [0, [166, 227, 161]],
  [50, [249, 226, 175]],
  [75, [250, 179, 135]],
  [100, [243, 139, 168]],
];

/** Color of a fill level (0–100), blended along the pastel scale green → yellow → peach → red, as CSS `rgb()`. */
export function usageColor(percent: number): string {
  const level = Math.min(Math.max(percent, 0), 100);
  const upper = USAGE_COLOR_STOPS.findIndex(([stop]) => stop >= level);
  if (upper <= 0) return toRgb(USAGE_COLOR_STOPS[0][1]);
  const [fromStop, from] = USAGE_COLOR_STOPS[upper - 1];
  const [toStop, to] = USAGE_COLOR_STOPS[upper];
  const ratio = (level - fromStop) / (toStop - fromStop);
  return toRgb([0, 1, 2].map((channel) => from[channel] + (to[channel] - from[channel]) * ratio));
}

function toRgb(rgb: number[]): string {
  return `rgb(${rgb.map(Math.round).join(" ")})`;
}
