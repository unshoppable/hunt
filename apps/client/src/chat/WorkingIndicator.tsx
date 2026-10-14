import { useEffect, useState } from "react";

/** Spinner glyph cycle of the Claude Code terminal. */
const SPINNER_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];

/** Activity verbs the terminal shows while a turn runs; one is picked per turn. */
const VERBS = [
  "Thinking",
  "Pondering",
  "Cogitating",
  "Brewing",
  "Mulling",
  "Percolating",
  "Synthesizing",
  "Crunching",
  "Churning",
  "Noodling",
  "Puzzling",
  "Simmering",
  "Deliberating",
  "Contemplating",
  "Marinating",
  "Ruminating",
  "Musing",
  "Scheming",
  "Hatching",
  "Combobulating",
  "Honking",
  "Vibing",
  "Manifesting",
  "Transmuting",
  "Forging",
];

/** `✻ Cogitating… (esc to interrupt · 12s)`: shown while the agent works on a turn. */
export function WorkingIndicator() {
  const [verb] = useState(() => VERBS[Math.floor(Math.random() * VERBS.length)]);
  const [frame, setFrame] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const spinner = setInterval(() => setFrame((current) => current + 1), 120);
    const clock = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => {
      clearInterval(spinner);
      clearInterval(clock);
    };
  }, []);

  return (
    <div className="flex gap-3">
      {/* Fixed box: the spinner glyphs differ in width and height, so the text next to them would otherwise shift every frame. */}
      <span className="inline-flex h-[1lh] w-4 shrink-0 select-none items-center justify-center text-(--chat-orange)">
        {SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}
      </span>
      <span className="text-(--chat-orange)">
        {verb}… <span className="text-neutral-500">(esc to interrupt · {elapsedSeconds}s)</span>
      </span>
    </div>
  );
}
