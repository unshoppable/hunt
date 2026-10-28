/**
 * The private files of a repository, the ignored files a handoff of the desktop copies (such as `.env.private`): the
 * Secret Manager secret that holds them as a gzipped tar archive and the check of its value before the poller
 * (`swf/poller.service.ts`) hands it to `hunt-ctl put-files`.
 */
import type { Repository } from "../../../../libs/domain/src/session/repository.value-object.ts";

/** The prefix of the Secret Manager secret that holds a repository's private files (`privateFilesSecret`). */
export const PRIVATE_FILES_SECRET_PREFIX = "HUNT_SWF_FILES_";
/** The first two bytes of a gzip stream. */
const GZIP_MAGIC = [0x1f, 0x8b];

/**
 * The name of the secret that holds the private files of `<owner>/<repo>` as a gzipped tar archive relative to the
 * repository's root: `HUNT_SWF_FILES_<owner>_<repo>`, with every character a secret name cannot hold replaced by `_`.
 */
export function privateFilesSecret(repo: Repository): string {
  return `${PRIVATE_FILES_SECRET_PREFIX}${repo.slug.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** Throws when `archive`, the value of the secret `name`, is no gzipped tar archive as `hunt-ctl put-files` expects. */
export function checkPrivateFilesArchive(archive: Uint8Array, name: string): void {
  if (archive.length < GZIP_MAGIC.length || archive[0] !== GZIP_MAGIC[0] || archive[1] !== GZIP_MAGIC[1]) {
    throw new Error(`the secret ${name} is no gzipped tar archive (tar -czf - <files> | gcloud secrets versions add ${name} --data-file=-)`);
  }
}
