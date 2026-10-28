/**
 * Writes a session VM's configuration from its repository's hunt.json (see `hunt-json.value-object.ts`);
 * `hunt-ctl session-config` runs it as root:
 *
 *   node /srv/hunt/current/session/configCli.mjs --worktree <dir> --short <8 hex digits> --domain <domain> --env-out <file>
 *     --caddy-out <file> --services-dir <dir> [--secrets <file>]
 *
 * --secrets names the remote secrets the gateway put on the VM (`/etc/hunt/remote-secrets.json`, the JSON object of
 * `libs/domain/src/remote-secrets/remote-secrets.utils.ts`), from which the services get the ones their `remoteSecrets` name; a missing file
 * means none.
 *
 * Writes the session's environment as a systemd EnvironmentFile to --env-out, the Caddy configuration of the VM's
 * preview proxy to --caddy-out and the environment of each service to `<services-dir>/<name>.env`, each through a
 * temporary file and a rename, mode 0644; the services' files, which hold remote secrets and only systemd reads, get
 * 0600. It creates --services-dir (0755) when it is missing and deletes the `*.env` files there of services that
 * hunt.json no longer declares; other files stay. Prints one line of JSON:
 * `{"ok": true, "services": [{"name", "port", "tls", "guarded"}], "services_prompt": "…", "agent_md": "…", "swf_model": "…",
 * "swf_human_review_paths": ["…"], "swf_skills": {"plan": "…", …}}` with the services in the order of hunt.json, the
 * section of the agent's prompt that lists them (or says there are none), the text of the repository's hunt.agent.md
 * (instructions for the agent, at most 20 KiB) when it has one, the `swf.model` of hunt.json when it sets one, its
 * `swf.humanReviewPaths` when it declares any and, when it has a `swf` section, the skill of every agent step
 * (`swf.skills` with the defaults of the steps it leaves out), or `{"ok": false, "problems": […]}`, each problem starting
 * with the path of the offending value; then it writes nothing and exits with 1. With a `swf` section, every agent
 * step's skill file `.claude/skills/<name>/SKILL.md` that the worktree lacks is a problem. The agent controls the
 * worktree, so hunt.json and hunt.agent.md are read only as regular files, never through a symlink.
 *
 *   node /srv/hunt/current/session/configCli.mjs --worktree <dir> --check <name>
 *
 * looks the check <name> up in hunt.json for `hunt-ctl check`, writes nothing and prints
 * `{"ok": true, "command": "…", "cwd": "<folder relative to the worktree, or null>"}`, or the problems as above when
 * hunt.json is invalid or declares no such check. `session-config.service.ts` does the work; this module prints its result.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import { runSessionConfig, type SessionConfigResult } from "./session-config.service.ts";

function main(): void {
  let result: SessionConfigResult;
  try {
    result = runSessionConfig(process.argv.slice(2));
  } catch (error) {
    result = { ok: false, problems: [messageOf(error)] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

// Node resolves the symlink /srv/hunt/current in the module's URL, not in argv.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
