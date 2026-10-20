import { HANDOFF_START_PROMPT } from "../preview/services";

/** Hunt's own chat prompts, which the chat shows as a one-line notice instead of a user bubble, keyed by their text. */
const NOTICES = new Map([[HANDOFF_START_PROMPT, "Hunt asked the agent to start the services on the VM"]]);

/** The notice the chat shows for a user turn Hunt sent itself, or null for a prompt of the user. */
export function huntPromptNotice(text: string): string | null {
  return NOTICES.get(text.trim()) ?? null;
}
