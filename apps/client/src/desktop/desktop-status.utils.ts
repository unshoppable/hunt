import type { VideoState } from "@rockorager/waymote";

export type Tone = "ok" | "pending" | "error" | "idle";

/** What the header of the Desktop tab says about the stream, and whether it offers to connect again. */
export type DesktopStatus = { text: string; tone: Tone; isBusy: boolean; canReconnect: boolean };

const CONNECTING: DesktopStatus = { text: "Connecting…", tone: "pending", isBusy: true, canReconnect: false };

/**
 * The state of the Desktop tab: `openError` when the forward to the VM could not be opened, `isOpening` while it is,
 * and `video` the stream's state once a session exists.
 */
export function describeDesktop({ openError, isOpening, video }: { openError: string | null; isOpening: boolean; video: VideoState | null }): DesktopStatus {
  if (openError) return { text: "Not connected", tone: "error", isBusy: false, canReconnect: true };
  if (!video) return isOpening ? CONNECTING : { text: "", tone: "idle", isBusy: false, canReconnect: false };
  switch (video.state) {
    case "connected":
      return { text: "Connected", tone: "ok", isBusy: false, canReconnect: false };
    case "idle":
    case "connecting":
      return CONNECTING;
    case "reconnecting":
      return { text: "Reconnecting…", tone: "pending", isBusy: true, canReconnect: true };
    case "disconnected":
      return { text: "Disconnected", tone: "idle", isBusy: false, canReconnect: true };
    case "error":
      return { text: video.message || "The stream failed", tone: "error", isBusy: false, canReconnect: true };
  }
}

/** Whether the stream just lost its connection, so the forward to the VM is worth checking: it entered `reconnecting`. */
export function hasLostConnection(previous: VideoState | null, current: VideoState): boolean {
  return current.state === "reconnecting" && previous?.state !== "reconnecting";
}
