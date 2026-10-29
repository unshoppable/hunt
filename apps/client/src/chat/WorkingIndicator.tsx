import { useEffect, useState } from "react";

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

/** The breathing agent sparkle with `Cogitating… (esc to interrupt · 12s)` beside it: shown while the agent works on a turn. */
export function WorkingIndicator() {
  const [verb] = useState(() => VERBS[Math.floor(Math.random() * VERBS.length)]);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const clock = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(clock);
  }, []);

  return (
    <div className="flex items-center gap-2.5">
      <span className="hunt-agent-sparkle" aria-hidden="true" />
      <span className="text-neutral-300">
        {verb}… <span className="text-neutral-500">(esc to interrupt · {elapsedSeconds}s)</span>
      </span>
    </div>
  );
}
