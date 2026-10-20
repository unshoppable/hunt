import { useEffect, useState, type RefObject } from "react";
import type { PendingPermission } from "../ipc/types";
import { ToolCallBody } from "./ToolCallCard";

/** Box title per tool kind, as the terminal names its permission dialogs. */
const TITLE_BY_KIND: Record<string, string> = {
  execute: "Bash command",
  edit: "Edit file",
  delete: "Delete file",
  move: "Move file",
  read: "Read file",
  search: "Search",
  fetch: "Fetch",
  think: "Tool use",
  switch_mode: "Switch mode",
  other: "Tool use",
};

/**
 * The terminal's permission dialog: a bordered box with the tool, its payload, and numbered options.
 * Keys work like the terminal: digits pick an option, arrows move, Enter confirms, Esc rejects. They are read
 * from the whole window unless `keyTarget` scopes them to one element (a popover that owns the keyboard).
 */
export function PermissionPrompt({
  permission,
  onAnswer,
  keyTarget,
}: {
  permission: PendingPermission;
  onAnswer: (optionId: string) => void;
  keyTarget?: RefObject<HTMLElement | null>;
}) {
  const toolCall = permission.toolCall;
  const options = permission.options;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const hasTextContent = (toolCall.content ?? []).some((entry) => entry.type === "content");
  const description = hasTextContent ? null : readDescription(toolCall.rawInput);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const digit = Number(event.key);
      if (event.key >= "1" && event.key <= "9" && digit <= options.length) {
        event.preventDefault();
        onAnswer(options[digit - 1].optionId);
        return;
      }
      switch (event.key) {
        case "ArrowDown":
        case "j":
          event.preventDefault();
          setSelectedIndex((current) => (current + 1) % options.length);
          break;
        case "ArrowUp":
        case "k":
          event.preventDefault();
          setSelectedIndex((current) => (current - 1 + options.length) % options.length);
          break;
        case "Enter":
          event.preventDefault();
          onAnswer(options[selectedIndex].optionId);
          break;
        case "Escape": {
          const reject = options.find((option) => option.kind === "reject_once") ?? options.find((option) => option.kind.startsWith("reject"));
          if (!reject) return;
          event.preventDefault();
          onAnswer(reject.optionId);
          break;
        }
      }
    }
    const target: Window | HTMLElement = keyTarget?.current ?? window;
    target.addEventListener("keydown", onKeyDown as EventListener);
    return () => target.removeEventListener("keydown", onKeyDown as EventListener);
  }, [options, selectedIndex, onAnswer, keyTarget]);

  return (
    <div className="my-4 rounded-md border border-(--chat-orange) px-4 py-3">
      <div className="font-semibold text-neutral-100">{TITLE_BY_KIND[toolCall.kind ?? "other"] ?? "Tool use"}</div>
      <div className="mt-3 flex flex-col gap-1 pl-2">
        <div className="break-words whitespace-pre-wrap text-neutral-100">{toolCall.title ?? toolCall.toolCallId}</div>
        {description ? <div className="text-neutral-400">{description}</div> : null}
        <ToolCallBody content={toolCall.content ?? []} rawInput={description ? undefined : toolCall.rawInput} />
      </div>
      <div className="mt-3 text-neutral-100">Do you want to proceed?</div>
      <div className="mt-1 flex flex-col">
        {options.map((option, index) => {
          const isSelected = index === selectedIndex;
          return (
            <button
              key={option.optionId}
              type="button"
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => onAnswer(option.optionId)}
              className={`flex gap-2 rounded px-1 text-left ${isSelected ? "bg-(--row-selected) text-(--chat-orange)" : "text-neutral-300 hover:bg-(--row-hover)"}`}
            >
              <span className="w-[1ch] shrink-0 select-none">{isSelected ? "❯" : ""}</span>
              <span className="select-none">{index + 1}.</span>
              <span>
                {option.name}
                {option.kind.startsWith("reject") ? <span className="text-neutral-500"> (esc)</span> : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Bash permission requests carry the model's own description of the command in `rawInput.description` when the content block does not. */
function readDescription(rawInput: unknown): string | null {
  if (!rawInput || typeof rawInput !== "object") return null;
  const description = (rawInput as { description?: unknown }).description;
  return typeof description === "string" && description ? description : null;
}
