import type { ShapeColor } from "./shape-diagram.types";

/** The colors an element can take, in the order the editor offers them; emerald and amber stay the change colors. */
export const SHAPE_COLORS: ShapeColor[] = ["blue", "cyan", "green", "violet", "pink", "red", "orange", "gray"];

/**
 * Tailwind classes of each color, written out so Tailwind finds them: a box's border and fill, an SVG shape's fill and
 * stroke, a person's icon, a table card's border and header tint, and the swatch in the editor.
 */
export const COLOR_STYLE: Record<ShapeColor, { box: string; svg: string; icon: string; card: string; header: string; swatch: string }> = {
  blue: { box: "border-blue-400/60 bg-blue-500/20", svg: "fill-blue-500/15 stroke-blue-400/60", icon: "fill-blue-300/80", card: "border-blue-400/50", header: "bg-blue-400/15", swatch: "bg-blue-400" },
  cyan: { box: "border-cyan-400/60 bg-cyan-500/20", svg: "fill-cyan-500/15 stroke-cyan-400/60", icon: "fill-cyan-300/80", card: "border-cyan-400/50", header: "bg-cyan-400/15", swatch: "bg-cyan-400" },
  green: { box: "border-green-400/60 bg-green-500/20", svg: "fill-green-500/15 stroke-green-400/60", icon: "fill-green-300/80", card: "border-green-400/50", header: "bg-green-400/15", swatch: "bg-green-400" },
  violet: { box: "border-violet-400/60 bg-violet-500/20", svg: "fill-violet-500/15 stroke-violet-400/60", icon: "fill-violet-300/80", card: "border-violet-400/50", header: "bg-violet-400/15", swatch: "bg-violet-400" },
  pink: { box: "border-pink-400/60 bg-pink-500/20", svg: "fill-pink-500/15 stroke-pink-400/60", icon: "fill-pink-300/80", card: "border-pink-400/50", header: "bg-pink-400/15", swatch: "bg-pink-400" },
  red: { box: "border-red-400/60 bg-red-500/20", svg: "fill-red-500/15 stroke-red-400/60", icon: "fill-red-300/80", card: "border-red-400/50", header: "bg-red-400/15", swatch: "bg-red-400" },
  orange: { box: "border-orange-400/60 bg-orange-500/20", svg: "fill-orange-500/15 stroke-orange-400/60", icon: "fill-orange-300/80", card: "border-orange-400/50", header: "bg-orange-400/15", swatch: "bg-orange-400" },
  gray: { box: "border-neutral-400/60 bg-neutral-500/20", svg: "fill-neutral-500/15 stroke-neutral-400/60", icon: "fill-neutral-300/80", card: "border-neutral-400/50", header: "bg-neutral-400/15", swatch: "bg-neutral-400" },
};

export function isShapeColor(value: unknown): value is ShapeColor {
  return typeof value === "string" && (SHAPE_COLORS as string[]).includes(value);
}
