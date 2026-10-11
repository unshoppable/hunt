import { useEffect, useRef, type DependencyList } from "react";

type LoadHandlers<T> = {
  onValue: (value: T) => void;
  onError: (reason: unknown) => void;
};

type LoadOptions = {
  /** Waits this long before loading, so a burst of changes (e.g. the agent editing files) loads once; read when a load is scheduled. */
  delayMs?: number;
  /** Skips loading (and keeps the current value) while false. */
  isEnabled?: boolean;
};

/**
 * Loads `load()` whenever `deps` change and hands the result to `onValue`, or a rejection to `onError`, unless the
 * deps changed again or the component unmounted in the meantime; a stale result never overwrites a newer one.
 * The handlers are read when the result arrives, so they may be fresh closures.
 */
export function useLoad<T>(load: () => Promise<T>, handlers: LoadHandlers<T>, deps: DependencyList, options: LoadOptions = {}): void {
  const { delayMs = 0, isEnabled = true } = options;
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const delayMsRef = useRef(delayMs);
  delayMsRef.current = delayMs;

  useEffect(() => {
    if (!isEnabled) return;
    let isCurrent = true;
    const delay = delayMsRef.current;
    const run = () => {
      load()
        .then((value) => isCurrent && handlersRef.current.onValue(value))
        .catch((reason) => isCurrent && handlersRef.current.onError(reason));
    };
    const timer = delay ? globalThis.setTimeout(run, delay) : undefined;
    if (!delay) {
      run();
    }
    return () => {
      isCurrent = false;
      globalThis.clearTimeout(timer);
    };
    // The loader is a closure over the deps; listing it would rerun the load on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEnabled, ...deps]);
}

/** The usual error handler: shows `reason` as text. */
export function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
