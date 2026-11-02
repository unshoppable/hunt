import type { AppPage } from "./preview.types";

/** The tooltip of "Browser": which apps it opens, or why it is disabled. */
export function browserButtonTitle(pages: readonly AppPage[]): string {
  if (!pages.length) return "Opens once a service of hunt.json marked \"frontend\": true runs on this Mac; start one in the Terminal tab";
  return `Open ${pages.map((page) => page.name).join(", ")} in this session's Chrome, which its agent drives, a tab each`;
}

/** Whether two reads of the pages list the same apps at the same URLs, so the inspector keeps the earlier one. */
export function isSamePages(left: readonly AppPage[], right: readonly AppPage[]): boolean {
  return left.length === right.length && left.every((page, index) => page.name === right[index].name && page.url === right[index].url);
}
