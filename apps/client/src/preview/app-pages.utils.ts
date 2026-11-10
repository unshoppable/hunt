import type { AppPage, PreviewStatus } from "./preview.types";

const NO_PAGES: AppPage[] = [];

/**
 * The frontend services of a remote session's preview that answer on its VM, at their preview URLs (as `remote_pages`
 * in src-tauri/src/agent/app_pages.rs, which "Browser" opens); none without a status.
 */
export function remoteAppPages(status: PreviewStatus | null): AppPage[] {
  const shown = status?.services.filter((service) => service.frontend && service.responds) ?? NO_PAGES;
  return shown.length ? shown.map(({ name, url }) => ({ name, url })) : NO_PAGES;
}

/** The tooltip of "Browser": which apps it opens, or why it is disabled; `isOnVm` for a session whose apps run on its VM. */
export function browserButtonTitle(pages: readonly AppPage[], isOnVm: boolean): string {
  const names = pages.map((page) => page.name).join(", ");
  if (isOnVm) {
    if (!pages.length) return "Opens once a service of hunt.json marked \"frontend\": true answers on the VM; start one in the Terminal tab";
    return `Open the preview of ${names} in this session's Chrome on this Mac, with the review widget, a tab each; the agent's Chromium is in the Desktop tab`;
  }
  if (!pages.length) return "Opens once a service of hunt.json marked \"frontend\": true runs on this Mac; start one in the Terminal tab";
  return `Open ${names} in this session's Chrome, which its agent drives, a tab each`;
}

/** Whether two reads of the pages list the same apps at the same URLs, so the inspector keeps the earlier one. */
export function isSamePages(left: readonly AppPage[], right: readonly AppPage[]): boolean {
  return left.length === right.length && left.every((page, index) => page.name === right[index].name && page.url === right[index].url);
}
