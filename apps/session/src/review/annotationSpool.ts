/**
 * The folder in which the review server (`server.ts`) leaves annotations for the status helper
 * (`../relay/statusHelper.ts`), which hands each one to the desktop client exactly once: one JSON file per annotation,
 * written to a hidden temporary name and renamed into place, so a reader never sees half a file. A reader claims a file
 * by renaming it to a hidden name before it reads it, so two helpers never deliver the same annotation; it deletes the
 * file once read.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseStoredBrowserAnnotation, type BrowserAnnotation, type StoredBrowserAnnotation } from "../../../../libs/domain/src/browserAnnotation.ts";
import { parseLine } from "../../../../libs/domain/src/ndjson.ts";

/** Where `hunt-review.service` keeps the annotations, in its runtime folder. */
export const DEFAULT_SPOOL_DIR = "/run/hunt-review/annotations";
/** How many annotations may wait; more are refused until a client fetches them. */
export const MAX_WAITING_ANNOTATIONS = 200;
/** `<createdAt>-<id>.json`; the time first, so that a sorted listing is in the order of arrival. */
const SPOOL_FILE = /^\d{13,}-[0-9a-f-]{36}\.json$/;

/** Creates the spool folder, readable by its owner only. */
export function ensureSpool(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** How many annotations wait in `dir`. */
export function waitingCount(dir: string): number {
  return readdirSync(dir).filter((name) => SPOOL_FILE.test(name)).length;
}

/** Stores `annotation` in `dir` with a new id and the time `now`; returns what was stored. */
export function storeAnnotation(dir: string, annotation: BrowserAnnotation, now: number = Date.now()): StoredBrowserAnnotation {
  const stored: StoredBrowserAnnotation = { id: randomUUID(), createdAt: now, ...annotation };
  const name = `${now}-${stored.id}.json`;
  const temporary = join(dir, `.${name}.tmp`);
  writeFileSync(temporary, JSON.stringify(stored), { mode: 0o600 });
  renameSync(temporary, join(dir, name));
  return stored;
}

/**
 * Takes every annotation waiting in `dir`, in the order of arrival, and deletes their files; a missing folder holds
 * none. A file another reader claimed first is skipped, one that is no annotation is deleted and reported to `onInvalid`.
 */
export function takeAnnotations(dir: string, onInvalid: (name: string) => void = () => {}): StoredBrowserAnnotation[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => SPOOL_FILE.test(name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const annotations: StoredBrowserAnnotation[] = [];
  for (const name of names) {
    const claimed = join(dir, `.claimed-${process.pid}-${name}`);
    try {
      renameSync(join(dir, name), claimed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const annotation = parseStoredBrowserAnnotation(parseLine(readFileSync(claimed, "utf8")));
    rmSync(claimed, { force: true });
    if (annotation) {
      annotations.push(annotation);
    } else {
      onInvalid(name);
    }
  }
  return annotations;
}
