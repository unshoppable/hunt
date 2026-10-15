import { useEffect, useRef } from "react";
import type { QueuedPrompt } from "../state/store";
import { CloseIcon, SendIcon } from "../ui/icons";
import { screenshotUrl } from "./ScreenshotPicker";

/** A row's button, shown while the row is hovered or the button focused. */
const ROW_BUTTON =
  "flex size-5 shrink-0 items-center justify-center rounded text-neutral-500 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-(--row-hover) hover:text-white focus-visible:opacity-100";

/**
 * Prompts waiting for the running turn to end, shown dimmed above the composer in sending order, like the queued
 * messages of the Claude Code terminal. The buttons of a row send the prompt at once, interrupting the running turn,
 * or take it back into the composer.
 */
export function QueuedPrompts({
  queue,
  onSendNow,
  onTakeBack,
}: {
  queue: QueuedPrompt[];
  onSendNow: (prompt: QueuedPrompt) => void;
  onTakeBack: (prompt: QueuedPrompt) => void;
}) {
  if (!queue.length) return null;
  return (
    <ul aria-label="Queued prompts" className="mb-2 flex flex-col gap-1 px-1 text-[13px] text-neutral-500">
      {queue.map((prompt) => (
        <li key={prompt.id} className="group flex items-start gap-2">
          <span aria-hidden="true" className="shrink-0 select-none">
            ↳
          </span>
          <span className="min-w-0 flex-1 truncate whitespace-pre" title={prompt.text}>
            {prompt.text || `${prompt.images.length} image${prompt.images.length === 1 ? "" : "s"}`}
          </span>
          {prompt.images.map((image) => (
            <img key={image.path} src={screenshotUrl(image)} alt="" title={image.name} className="size-5 shrink-0 rounded border border-white/10 object-cover" />
          ))}
          <button type="button" onClick={() => onSendNow(prompt)} title="Send now; stops the running turn" aria-label="Send the queued prompt now" className={ROW_BUTTON}>
            <SendIcon className="size-3" />
          </button>
          <button type="button" onClick={() => onTakeBack(prompt)} title="Take back into the prompt box" aria-label="Take the queued prompt back into the prompt box" className={ROW_BUTTON}>
            <CloseIcon className="size-2.5" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Hands every queued prompt back to the composer once the chat is idle while prompts are still queued: a stopped or
 * failed turn never sent them. `takeQueue` empties the chat's queue; `onReturn` puts the prompts into the composer.
 */
export function useReturnedPrompts(isBusy: boolean, queue: QueuedPrompt[], takeQueue: () => QueuedPrompt[], onReturn: (prompts: QueuedPrompt[]) => void) {
  const latest = useRef({ takeQueue, onReturn });
  latest.current = { takeQueue, onReturn };
  useEffect(() => {
    if (isBusy || !queue.length) return;
    latest.current.onReturn(latest.current.takeQueue());
  }, [isBusy, queue]);
}

/** `text` with the queued prompts' texts appended, each as its own paragraph. */
export function appendPromptTexts(text: string, prompts: QueuedPrompt[]): string {
  return [text, ...prompts.map((prompt) => prompt.text)].filter((part) => part.trim()).join("\n\n");
}
