import { describe, expect, it } from "vitest";
import type { VideoState } from "@rockorager/waymote";
import { describeDesktop, hasLostConnection } from "./desktopStatus";

function video(state: VideoState["state"], message = ""): VideoState {
  return { state, message, codec: null };
}

describe("describeDesktop", () => {
  it("says what the forward and the stream do", () => {
    expect(describeDesktop({ openError: null, isOpening: false, video: null })).toEqual({ text: "", tone: "idle", isBusy: false, canReconnect: false });
    expect(describeDesktop({ openError: null, isOpening: true, video: null })).toMatchObject({ text: "Connecting…", isBusy: true });
    expect(describeDesktop({ openError: null, isOpening: false, video: video("connected") })).toMatchObject({ text: "Connected", tone: "ok" });
    expect(describeDesktop({ openError: null, isOpening: false, video: video("reconnecting") })).toMatchObject({ isBusy: true, canReconnect: true });
    expect(describeDesktop({ openError: null, isOpening: false, video: video("disconnected") })).toMatchObject({ canReconnect: true });
  });

  it("puts a failed open before the stream and shows the stream's own error", () => {
    expect(describeDesktop({ openError: "failed to open", isOpening: false, video: video("connected") })).toMatchObject({ tone: "error", canReconnect: true });
    const failed = describeDesktop({ openError: null, isOpening: false, video: video("error", "Decoder failed") });
    expect(failed).toMatchObject({ text: "Decoder failed", tone: "error" });
    expect(describeDesktop({ openError: null, isOpening: false, video: video("error") })).toMatchObject({ text: "The stream failed" });
  });
});

describe("hasLostConnection", () => {
  it("is true only when the stream enters reconnecting", () => {
    expect(hasLostConnection(video("connected"), video("reconnecting"))).toBe(true);
    expect(hasLostConnection(null, video("reconnecting"))).toBe(true);
    expect(hasLostConnection(video("reconnecting"), video("reconnecting"))).toBe(false);
    expect(hasLostConnection(video("connecting"), video("connected"))).toBe(false);
  });
});
