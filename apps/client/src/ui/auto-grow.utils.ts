/** Outer height in px a textarea takes for `rows` lines of its current font, padding included. */
export function rowsHeight(element: HTMLTextAreaElement, rows: number): number {
  const style = getComputedStyle(element);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
  return rows * lineHeight + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
}
