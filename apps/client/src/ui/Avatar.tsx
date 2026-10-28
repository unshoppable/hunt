import { useState } from "react";

/**
 * GitHub avatar of `login` from `url`, else from `github.com/<login>.png`, in a circle of the Tailwind `size`; the
 * first letter stands in while it loads or when it cannot be fetched (bots, offline), nothing while `login` is unknown.
 */
export function Avatar({ login, url, size }: { login: string | null; url?: string; size: string }) {
  const source = url || (login ? `https://github.com/${login}.png?size=64` : null);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const initial = login?.replace(/^app\//, "").charAt(0).toUpperCase() ?? "";
  return (
    <span
      className={`relative flex ${size} shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-700 text-[12px] font-semibold text-neutral-200`}
      title={login ?? undefined}
    >
      {initial}
      {source && source !== failedSource ? (
        <img src={source} alt="" onError={() => setFailedSource(source)} className="absolute inset-0 size-full object-cover" />
      ) : null}
    </span>
  );
}
