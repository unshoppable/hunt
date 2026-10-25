import guardrailChatPrompt from "../../prompts/guardrail-chat.system-prompt.md?raw";
import type { ChatItem, GuardrailDeclineReason } from "../ipc/types";
import type { GuardrailKind } from "../guardrails/guardrails";
import { fillPrompt } from "../../../../libs/domain/src/prompts.ts";
import { QUESTION_MARKER } from "../../../../libs/domain/src/question.ts";
import { stripChangeMarker } from "./changeReferences";

const KINDS: GuardrailKind[] = ["instruction", "rule", "skill", "agent", "adr"];

/** The reasons the "Decline" button of the guardrail chat offers, in menu order. */
export const DECLINE_REASONS: { id: GuardrailDeclineReason; name: string; description: string }[] = [
  { id: "tooSpecific", name: "Too specific", description: "A one-off detail no later task needs" },
  { id: "alreadyRecorded", name: "Already recorded", description: "A guardrail or the code already says it" },
  { id: "notWanted", name: "Not wanted", description: "Wrong, or not worth recording" },
];

/** A guardrail the agent proposed at the end of a reply: its kind, what it should say and the id of the reply. */
export type GuardrailSuggestion = { kind: GuardrailKind; summary: string; replyId: string };

/**
 * `<!-- hunt:guardrail adr: Summary -->` on a line of its own, which the agent ends a reply with when it holds a guardrail,
 * before the question marker if the reply has one (see `prompts/guardrail-offer.system-prompt.md`).
 */
const MARKER = /^[ \t]*<!--\s*hunt:guardrail\s+(\w+)\s*:?\s*([\s\S]*?)\s*-->[ \t]*$/m;
/** A comment at the end of a reply (its text may hold `>`), also any prefix of one while the marker is still streaming in. */
const TRAILING_MARKER = /\s*<(?:!(?:-(?:-(?:(?!-->)[\s\S])*(?:-->)?)?)?)?\s*$/;
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
    return kind ? { kind, summary: match?.[2] ?? "", replyId: item.id } : null;
  }
  return null;
}

/** The reply without the suggestion marker and a trailing comment such as the question marker, as it is shown and copied. */
export function stripGuardrailMarker(text: string): string {
  return text.replace(MARKER, "").replace(TRAILING_MARKER, "").trimEnd();
}

/**
 * The prompt the "Guardrail" button prefills: the repository's guardrail skill (`guardrailSkillOf`) invoked with the
 * suggested guardrail, or bare for the user to complete.
 */
export function buildGuardrailRequest(suggestion: GuardrailSuggestion | null, kindLabel: string, skill: string): string {
  return suggestion ? `/${skill} ${kindLabel}: ${suggestion.summary}` : `/${skill} `;
}

/** The task of the guardrail chat (`prompts/guardrail-chat.system-prompt.md`): follow the skill, with the conversation as context. */
export function guardrailChatTask(skill: string, transcript: string): string {
  return fillPrompt(guardrailChatPrompt, { skillName: skill, skillFile: `.claude/skills/${skill}/SKILL.md`, transcript });
}

/** The user and agent messages of a chat as Markdown without Hunt's markers, newest last, cut to the last `TRANSCRIPT_LIMIT` characters. */
export function buildTranscript(items: ChatItem[]): string {
  const messages = items.flatMap((item) => {
    if (item.kind === "user") return [`### User\n${item.text}`];
    if (item.kind === "agent") return [`### Agent\n${stripChangeMarker(item.text).replace(MARKER, "").replace(QUESTION_MARKER, "").trimEnd()}`];
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
