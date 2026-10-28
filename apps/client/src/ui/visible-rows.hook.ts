import { useEffect, useState, type RefObject } from "react";

/**
 * Indexes of the rows of the scroll container `listRef` that are on screen. Rows are the elements inside it with a
 * `data-row` attribute holding their index; `rows` is whatever the rows are rendered from, so new rows are observed
 * whenever it changes.
 */
export function useVisibleRows(listRef: RefObject<HTMLElement | null>, rows: unknown): ReadonlySet<number> {
  const [visibleRows, setVisibleRows] = useState<ReadonlySet<number>>(() => new Set());

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    // The first callback reports every observed row, so the set starts empty with each new set of rows.
    const onScreen = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const row = Number((entry.target as HTMLElement).dataset.row);
          if (entry.isIntersecting) {
            onScreen.add(row);
          } else {
            onScreen.delete(row);
          }
        }
        setVisibleRows(new Set(onScreen));
      },
      { root: list },
    );
    for (const row of list.querySelectorAll("[data-row]")) {
      observer.observe(row);
    }
    return () => observer.disconnect();
  }, [listRef, rows]);

  return visibleRows;
}
