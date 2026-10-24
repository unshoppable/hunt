import { useEffect, useRef, useState } from "react";
import { WaymoteSession, type VideoState } from "@rockorager/waymote";
import { commands } from "../ipc/commands";
import type { DesktopEndpoint } from "../ipc/types";
import { HEADER_BAR } from "../ui/bars";
import { GHOST_BUTTON_XS } from "../ui/buttons";
import { Spinner } from "../ui/icons";
import { REMOTE_INPUT_ATTRIBUTE } from "../ui/shortcuts";
import { errorText, useLoad } from "../ui/useLoad";
import { describeDesktop, hasLostConnection, type Tone } from "./desktopStatus";

const TONE_COLOR: Record<Tone, string> = {
  ok: "text-green-300",
  pending: "text-neutral-300",
  error: "text-red-300",
  idle: "text-neutral-400",
};

/**
 * The Desktop tab of a remote session: the VM's desktop, where the agent drives Chromium, streamed by its Waymote
 * gateway through a forward of the shared SSH connection (`desktop_open`). The canvas fills the panel and the VM's
 * output follows its size; audio stays off. Clicking the stream gives it the keyboard, Escape and ⌘ shortcuts included:
 * the stage is a remote input, which Hunt's shortcuts skip (`isRemoteInput`), and its keys go no further than the stage,
 * past the window's Escape listeners. Clicking outside gives the keys back to Hunt. The panel connects the first time it shows and
 * stays mounted while another tab shows, so the stream survives tab switches; another session unmounts it.
 */
export function DesktopPanel({ sessionId, isVisible }: { sessionId: string; isVisible: boolean }) {
  const [hasShown, setHasShown] = useState(isVisible);
  const [endpoint, setEndpoint] = useState<DesktopEndpoint | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  /** Counts the opens asked for after the first, so each one loads the endpoint again. */
  const [reopenCount, setReopenCount] = useState(0);
  const [video, setVideo] = useState<VideoState | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [hasFocus, setHasFocus] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  if (isVisible && !hasShown) {
    setHasShown(true);
  }

  // A forward that answers keeps its URL; the stream then reconnects by itself and is left alone.
  useLoad(
    () => commands.desktopOpen(sessionId),
    {
      onValue: (opened) => {
        setOpenError(null);
        setEndpoint((current) => (current?.url === opened.url ? current : opened));
      },
      onError: (reason) => setOpenError(errorText(reason)),
    },
    [sessionId, reopenCount],
    { isEnabled: hasShown },
  );

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    const textInput = textInputRef.current;
    if (!endpoint || !stage || !canvas || !textInput) return;
    const session = new WaymoteSession({ endpoint: endpoint.url, audio: false, remoteDisplay: { mode: "observe", element: stage } });
    session.attachSurface({ canvas, textInputElement: textInput, controlOnFocus: true });
    let previousVideo: VideoState | null = null;
    const unsubscribers = [
      session.on("state", (state) => {
        const hasLost = hasLostConnection(previousVideo, state.video);
        previousVideo = state.video;
        setVideo(state.video);
        if (state.video.state === "connected") {
          setOpenError(null);
          setStreamError(null);
        }
        // A forward the SSH master took down with it is opened anew under another port.
        if (hasLost) {
          setReopenCount((count) => count + 1);
        }
      }),
      session.on("error", (error) => setStreamError(error.message)),
    ];
    session.connect();
    // Holding the input from the start lets the VM's output take the panel's size before the first click.
    session.input.acquire();
    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
      void session.dispose();
    };
  }, [endpoint]);

  const reconnect = () => {
    setEndpoint(null);
    setVideo(null);
    setOpenError(null);
    setStreamError(null);
    setReopenCount((count) => count + 1);
  };

  const isOpening = hasShown && !endpoint && !openError;
  const status = describeDesktop({ openError, isOpening, video: endpoint ? video : null });
  const error = openError ?? streamError;

  return (
    <div className={`h-full min-h-0 flex-col ${isVisible ? "flex" : "hidden"}`}>
      <div className={`${HEADER_BAR} gap-2 border-b border-(--line) px-4`}>
        <span className="text-sm font-medium text-neutral-100">Desktop</span>
        <span className={`min-w-0 truncate text-[13px] ${TONE_COLOR[status.tone]}`}>{status.text}</span>
        <span className="flex-1" />
        {hasFocus ? <span className="min-w-0 truncate text-[13px] text-neutral-500">Escape and ⌘ keys go to the VM</span> : null}
        {status.isBusy ? <Spinner /> : null}
        {status.canReconnect ? (
          <button type="button" onClick={reconnect} className={GHOST_BUTTON_XS}>
            Reconnect
          </button>
        ) : null}
      </div>
      {error ? <p className="border-b border-(--line) px-4 py-2 text-[13px] leading-snug break-words text-red-300">{error}</p> : null}
      <div
        ref={stageRef}
        {...{ [REMOTE_INPUT_ATTRIBUTE]: "" }}
        className={`relative min-h-0 flex-1 overflow-hidden ${endpoint ? "bg-black" : ""}`}
        onFocus={() => setHasFocus(true)}
        onBlur={() => setHasFocus(false)}
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
      >
        <canvas ref={canvasRef} tabIndex={0} aria-label="Remote desktop" className="absolute inset-0 size-full object-contain outline-none" />
        <input
          ref={textInputRef}
          type="text"
          tabIndex={-1}
          autoComplete="off"
          aria-label="Remote text input"
          className="pointer-events-none absolute bottom-0 left-0 size-px opacity-0"
        />
        {isOpening ? (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-[13px] text-neutral-500">
            <Spinner />
            <span>Opening the connection to the VM…</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
