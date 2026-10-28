import type { DownloadEvent } from "../ipc/updater.utils";

/** How far an update download is; `totalBytes` is null when the server sent no content length. */
export type DownloadProgress = { downloadedBytes: number; totalBytes: number | null; isFinished: boolean };

export const NO_PROGRESS: DownloadProgress = { downloadedBytes: 0, totalBytes: null, isFinished: false };

/** Folds one updater download event into the progress so far. */
export function applyDownloadEvent(progress: DownloadProgress, event: DownloadEvent): DownloadProgress {
  switch (event.event) {
    case "Started":
      return { downloadedBytes: 0, totalBytes: event.data.contentLength ?? null, isFinished: false };
    case "Progress":
      return { ...progress, downloadedBytes: progress.downloadedBytes + event.data.chunkLength };
    case "Finished":
      return { ...progress, isFinished: true };
  }
}

/** Share of the download that is done, 0 to 1, or null while the total is unknown. */
export function downloadFraction(progress: DownloadProgress): number | null {
  if (progress.isFinished) return 1;
  if (!progress.totalBytes) return null;
  return Math.min(1, progress.downloadedBytes / progress.totalBytes);
}

/** `1.2 MB`, `840 kB`, `12 B`; one decimal only for megabytes and up. */
export function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} kB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** The line shown under the progress bar: `12.3 MB of 45.0 MB`, `12.3 MB` without a total, `Installing…` once downloaded. */
export function describeProgress(progress: DownloadProgress): string {
  if (progress.isFinished) return "Installing…";
  if (!progress.totalBytes) return formatBytes(progress.downloadedBytes);
  return `${formatBytes(progress.downloadedBytes)} of ${formatBytes(progress.totalBytes)}`;
}
