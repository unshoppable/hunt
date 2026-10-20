import type { ChatItem } from "../ipc/types";
import type { GuardrailKind } from "../state/settings";
import { QUESTION_MARKER } from "../../../../libs/domain/src/question.ts";

const KINDS: GuardrailKind[] = ["instruction", "rule", "skill", "agent", "adr"];

/** A guardrail the agent proposed at the end of a reply: its kind and what it should say. */
export type GuardrailSuggestion = { kind: GuardrailKind; summary: string };

/**
 * `<!-- hunt:guardrail adr: Summary -->` on a line of its own, which the agent ends a reply with when it holds a guardrail,
 * before the question marker if the reply has one (see `prompts/guardrail-offer.system-prompt.md`).
 */
const MARKER = /^[ \t]*<!--\s*hunt:guardrail\s+(\w+)\s*:?\s*([\s\S]*?)\s*-->[ \t]*$/m;
/** A comment at the end of a reply (its text may hold `>`), also any prefix of one while the marker is still streaming in. */
const TRAILING_MARKER = /\s*<(?:!(?:-(?:-(?:(?!-->)[\s\S])*(?:-->)?)?)?)?\s*$/;
/** The first line of every guardrail request the "Guardrail" button prefills. */
const REQUEST_LEAD = "Erzeuge eine passende Guardrail für folgendes:";
/** Characters of the conversation handed to the guardrail agent; older messages are cut off beyond that. */
const TRANSCRIPT_LIMIT = 60_000;

/** The guardrail the agent suggested in its reply to the last user prompt; null when it suggested none. */
export function findGuardrailSuggestion(items: ChatItem[]): GuardrailSuggestion | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item.kind === "user") return null;
    if (item.kind !== "agent") continue;
    const match = item.text.match(MARKER);
    const kind = KINDS.find((candidate) => candidate === match?.[1]);
    return kind ? { kind, summary: match?.[2] ?? "" } : null;
  }
  return null;
}

/** The reply without the suggestion marker and a trailing comment such as the question marker, as it is shown and copied. */
export function stripGuardrailMarker(text: string): string {
  return text.replace(MARKER, "").replace(TRAILING_MARKER, "").trimEnd();
}

/** The prompt the "Guardrail" button prefills: the suggested guardrail, or the bare request for the user to complete. */
export function buildGuardrailRequest(suggestion: GuardrailSuggestion | null, kindLabel: string): string {
  return suggestion ? `${REQUEST_LEAD}\n${kindLabel}: ${suggestion.summary}` : `${REQUEST_LEAD}\n`;
}

/** The user and agent messages of a chat as Markdown without Hunt's markers, newest last, cut to the last `TRANSCRIPT_LIMIT` characters. */
export function buildTranscript(items: ChatItem[]): string {
  const messages = items.flatMap((item) => {
    if (item.kind === "user") return [`### User\n${item.text}`];
    if (item.kind === "agent") return [`### Agent\n${item.text.replace(MARKER, "").replace(QUESTION_MARKER, "").trimEnd()}`];
    return [];
  });
  const transcript = messages.join("\n\n");
  return transcript.length > TRANSCRIPT_LIMIT ? `…\n${transcript.slice(-TRANSCRIPT_LIMIT)}` : transcript;
}

/** The last `count` non-empty lines of `transcript`, led by "…" when earlier lines are left out. */
export function transcriptTail(transcript: string, count: number): string {
  const lines = transcript.split("\n").filter((line) => line.trim());
  return lines.length > count ? `…\n${lines.slice(-count).join("\n")}` : lines.join("\n");
}
