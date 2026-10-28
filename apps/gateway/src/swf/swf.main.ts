/**
 * hunt-swf on the gateway (`hunt-swf.service`): runs a `cycle()` of the poller (`swf/poller.service.ts`) every
 * POLL_INTERVAL_MS, since the gateway sits behind IAP and receives no webhooks, and after each one a cycle of the idle
 * sweeper (`session-vm/idle-sweeper.service.ts`), which suspends session VMs whose session is idle, and of the reaper
 * (`session-vm/reaper.service.ts`), which deletes session VMs that have been off for more than a week.
 *
 *   node /srv/hunt/current/gateway/swf.mjs      (the bundle `nx build gateway` writes)
 *
 * The poller's dependencies come from the gateway: the GitHub App's id and private key and the Claude Code OAuth token
 * (`swf/swf-secrets.utils.ts`) and the private files of each repository (`swf/private-files.utils.ts`) from Secret
 * Manager; project, zone, access token and configuration from the metadata server; the preview domain from what
 * `hunt-ctl install` wrote (`shared/preview-domain.utils.ts`); the prompt files from `readPrompts`, which the build bundles
 * in through the `?raw` imports. Every log line goes to the journal (`shared/journal.utils.ts`), redacted
 * (`swf/redaction.utils.ts`). SIGHUP (the unit's reload, after an install) makes hunt-swf exit once the sessions the
 * poller sets up are running, so that systemd starts the new release; SIGTERM marks those still being set up as failed
 * and exits. Runs on Node 24 through type stripping; no dependencies.
 */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import gitPushPrompt from "../../../../libs/domain/prompts/git-push.system-prompt.md?raw";
import questionPrompt from "../../../../libs/domain/prompts/question.system-prompt.md?raw";
import remotePrompt from "../../../../libs/domain/prompts/remote.system-prompt.md?raw";
import sessionsPrompt from "../../../../libs/domain/prompts/sessions.system-prompt.md?raw";
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import type { Log } from "../../../../libs/domain/src/shared/journal.utils.ts";
import swfSystemPromptFile from "../../software-factory/0-system-prompt.md?raw";
import swfPlanPrompt from "../../software-factory/1-plan.user-prompt.md?raw";
import swfImplementPrompt from "../../software-factory/2-implement.user-prompt.md?raw";
import swfEscalatePrompt from "../../software-factory/2-implement-escalate.user-prompt.md?raw";
import swfVerifyPrompt from "../../software-factory/3-verify.user-prompt.md?raw";
import swfGatePrompt from "../../software-factory/4-gate.user-prompt.md?raw";
import swfPrPrompt from "../../software-factory/5-pr.user-prompt.md?raw";
import swfNudgePrompt from "../../software-factory/nudge.user-prompt.md?raw";
import swfAnswerPrompt from "../../software-factory/answer.user-prompt.md?raw";
import swfBadResultPrompt from "../../software-factory/bad-result.user-prompt.md?raw";
import { createCompute } from "../gcp/compute-engine.client.ts";
import { createMetadata } from "../gcp/metadata-server.client.ts";
import { readOptionalSecretBytes } from "../gcp/secret-manager.client.ts";
import { IdleSweeper } from "../session-vm/idle-sweeper.service.ts";
import { Reaper } from "../session-vm/reaper.service.ts";
import { sendPrompt } from "../session-vm/relay.client.ts";
import { createSessionVmSsh, ensureSshKey } from "../session-vm/session-vm-ssh.client.ts";
import { createSessionVmService } from "../session-vm/session-vm.service.ts";
import { writeLog } from "../shared/journal.utils.ts";
import { readDomain } from "../shared/preview-domain.utils.ts";
import { createGitHubApp } from "./github-app.client.ts";
import { createGitHub } from "./github.client.ts";
import { Poller } from "./poller.service.ts";
import { redact } from "./redaction.utils.ts";
import { readSwfConfig } from "./swf-config.utils.ts";
import type { PromptFiles } from "./swf-prompts.utils.ts";
import { secretsReader } from "./swf-secrets.utils.ts";

export const POLL_INTERVAL_MS = 30_000;
/** How long SIGTERM waits for the issues of unfinished setups to be marked as failed. */
const ABORT_TIMEOUT_MS = 20_000;

/** The prompt files, bundled into the poller at build time. */
function readPrompts(): PromptFiles {
  return {
    remote: remotePrompt,
    gitPush: gitPushPrompt,
    question: questionPrompt,
    sessions: sessionsPrompt,
    swfSystem: swfSystemPromptFile,
    swfPlan: swfPlanPrompt,
    swfImplement: swfImplementPrompt,
    swfEscalate: swfEscalatePrompt,
    swfVerify: swfVerifyPrompt,
    swfGate: swfGatePrompt,
    swfPr: swfPrPrompt,
    swfNudge: swfNudgePrompt,
    swfAnswer: swfAnswerPrompt,
    swfBadResult: swfBadResultPrompt,
  };
}

async function main(): Promise<void> {
  const log: Log = (message, level) => writeLog(redact(message, []), level);
  ensureSshKey("hunt-swf");
  const metadata = createMetadata();
  const location = { project: await metadata.project(), zone: await metadata.zone() };
  const compute = createCompute(metadata, fetch, log);
  const vm = (name: string, zone: string) => createSessionVmSsh(name, { project: location.project, zone }, log);
  let wake = () => {};
  let isStopping = false;
  const sessionVmService = await createSessionVmService(metadata, compute, log);
  const secrets = secretsReader(metadata);
  const githubApp = createGitHubApp({ credentials: async () => (await secrets()).app });
  const poller = new Poller({
    readConfig: () => readSwfConfig(metadata),
    readDomain: () => readDomain(),
    secrets,
    secretBytes: (name) => readOptionalSecretBytes(metadata, name),
    github: createGitHub((repo) => githubApp.tokenFor(repo)),
    githubApp,
    compute,
    sessionVmService,
    vm,
    prompts: readPrompts,
    sendPrompt,
    newId: randomUUID,
    log,
  });
  const reaper = new Reaper({ compute, sessionVmService, zone: location.zone, now: Date.now, log });
  const sweeper = new IdleSweeper({ compute, sessionVmService, vm, zone: location.zone, now: Date.now, log });

  process.on("SIGHUP", () => {
    log("reload: exiting once the sessions being set up run");
    isStopping = true;
    wake();
  });
  process.on("SIGTERM", () => {
    log("stopping: marking the sessions being set up as failed");
    const timeout = setTimeout(() => process.exit(0), ABORT_TIMEOUT_MS);
    void poller.abort("the gateway's poller stopped while it set the session up").finally(() => {
      clearTimeout(timeout);
      process.exit(0);
    });
  });

  log(`polling every ${POLL_INTERVAL_MS / 1000} s in ${location.project}/${location.zone}`);
  while (!isStopping) {
    try {
      await poller.cycle();
    } catch (error) {
      log(`poll failed: ${redact(messageOf(error), [])}`, "error");
    }
    await sweeper.cycle();
    await reaper.cycle();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, POLL_INTERVAL_MS);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  await poller.drain();
  process.exit(0);
}

// Node resolves the symlink /srv/hunt/current in the module's URL, not in argv.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    writeLog(redact(messageOf(error), []), "fatal");
    process.exit(1);
  });
}
