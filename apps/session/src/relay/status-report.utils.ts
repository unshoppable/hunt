/**
 * What the status helper (`status-helper.main.ts`) tells the desktop client about the relay of a session VM, read from the
 * relay's `status.json` (`libs/domain/src/relay/relay-status.types.ts`). The helper writes one JSON object per line to
 * stdout:
 *
 * - `{"t":"ready"}` once it runs.
 * - `{"t":"status","turn":"running"|"idle"|null,"question":bool|null,"lastTurnEndedAt":ms|null}` right after `ready`
 *   and then whenever one of the fields changes. `turn` is null while the relay serves no session: there is no status
 *   file, the relay is starting or failed, or its heartbeat is older than `HEARTBEAT_MAX_AGE_MS`; the other fields are
 *   null then too. `question` is also null when the relay is too old to report it.
 * - `{"t":"annotation","annotation":{…}}` once for every annotation the review widget of a preview page stored
 *   (`StoredBrowserAnnotation` of `libs/domain/src/review/browser-annotation.utils.ts`), in the order of arrival; the helper takes it
 *   out of the review server's spool folder, so no other client gets it.
 */
import type { TurnState } from "../../../../libs/domain/src/relay/relay-status.types.ts";
import type { StoredBrowserAnnotation } from "../../../../libs/domain/src/review/browser-annotation.utils.ts";
import { isRecord } from "../../../../libs/domain/src/shared/json-rpc.utils.ts";
import { parseLine } from "../../../../libs/domain/src/shared/ndjson.utils.ts";

/** A heartbeat older than this means the relay is gone; `hunt-ctl` and `hunt-idle-check` use the same limit. */
export const HEARTBEAT_MAX_AGE_MS = 120_000;

export interface StatusReport {
  t: "status";
  turn: TurnState | null;
  /** Whether the agent's last turn ended with a message asking a question. */
  question: boolean | null;
  lastTurnEndedAt: number | null;
}

export interface AnnotationReport {
  t: "annotation";
  annotation: StoredBrowserAnnotation;
}

const NOT_SERVING: StatusReport = { t: "status", turn: null, question: null, lastTurnEndedAt: null };

/**
 * The report for the content of `status.json` (`text`, null when the file is missing) at `now`. A heartbeat counts as
 * fresh until `HEARTBEAT_MAX_AGE_MS` after `startedAt`, the helper's start, at the earliest: after a resume from a
 * suspend the file holds the heartbeat from before the suspend until the relay writes the next one.
 */
export function reportOf(text: string | null, now: number, startedAt: number): StatusReport {
  if (!text) return NOT_SERVING;
  const status = parseLine(text);
  if (!isRecord(status) || status.state !== "ready") return NOT_SERVING;
  const { turn, heartbeatAt, question, lastTurnEndedAt } = status;
  if (turn !== "running" && turn !== "idle") return NOT_SERVING;
  if (Math.max(typeof heartbeatAt === "number" ? heartbeatAt : 0, startedAt) < now - HEARTBEAT_MAX_AGE_MS) return NOT_SERVING;
  return {
    t: "status",
    turn,
    question: typeof question === "boolean" ? question : null,
    lastTurnEndedAt: typeof lastTurnEndedAt === "number" ? lastTurnEndedAt : null,
  };
}
