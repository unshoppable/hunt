import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type * as z from "zod/mini";
import { Repository } from "../session/repository.value-object.ts";
import { SessionId } from "../session/session-id.value-object.ts";
import type { SwfStep } from "./swf-step.types.ts";
import { WorkflowLabels } from "./workflow-labels.value-object.ts";
import { Pipeline, type Run } from "./pipeline.domain.ts";
import {
  answerPrompt,
  badResultPrompt,
  continuePrompt,
  gatePrompt,
  huntSessionFile,
  nudgePrompt,
  remoteSystemPrompt,
  stepPrompt,
  swfSystemPrompt,
  type CommentText,
  type GateFailure,
  type IssueText,
} from "./swf-prompts.utils.ts";
import { settingsWith, SKILLS, started } from "./swf.fixtures.ts";

/** The poller's clock in the tests: 2026-10-25 10:00 UTC. */
const NOW = Date.UTC(2026, 9, 25, 10, 0, 0);

const REPO = Repository.fromSlug("acme/app");
/** The branch the plan step of every pipeline of the tests created. */
const BRANCH = "feat/general/12-fix-login";
const QUESTION_PREFIX = "❓ RÜCKFRAGE";

function issue(number: number, title = `Issue ${number}`): IssueText {
  return { number, title, body: "", author: "alice", createdAt: "2026-10-13T08:04:05Z", url: `https://github.com/acme/app/issues/${number}` };
}

/** A fresh pipeline at `step`, apart from `fields`. */
function pipelineAt(step: SwfStep, fields: Partial<z.input<typeof Pipeline.schema>> = {}): Pipeline {
  return new Pipeline({ ...started(NOW).toJSON(), branch: BRANCH, step, runs: [runOf(1, step)], ...fields });
}

/** A run of `step` that started at NOW and still runs, apart from `fields`. */
function runOf(n: number, step: SwfStep, fields: Partial<Run> = {}): Run {
  return { n, step, startedAt: new Date(NOW).toISOString(), endedAt: null, outcome: "running", ...fields };
}

/** `pipeline` after `findings` sent it back to implement. */
function sentBack(pipeline: Pipeline, findings: string[]): Pipeline {
  pipeline.sendBackToImplement(findings, NOW);
  return pipeline;
}

const prompts = {
  remote: readFileSync(new URL("../../prompts/remote.system-prompt.md", import.meta.url), "utf8"),
  gitPush: readFileSync(new URL("../../prompts/git-push.system-prompt.md", import.meta.url), "utf8"),
  question: readFileSync(new URL("../../prompts/question.system-prompt.md", import.meta.url), "utf8"),
  sessions: readFileSync(new URL("../../prompts/sessions.system-prompt.md", import.meta.url), "utf8"),
  swfSystem: readFileSync(new URL("../../prompts/swf/0-system-prompt.md", import.meta.url), "utf8"),
  swfPlan: readFileSync(new URL("../../prompts/swf/1-plan.user-prompt.md", import.meta.url), "utf8"),
  swfImplement: readFileSync(new URL("../../prompts/swf/2-implement.user-prompt.md", import.meta.url), "utf8"),
  swfEscalate: readFileSync(new URL("../../prompts/swf/2-implement-escalate.user-prompt.md", import.meta.url), "utf8"),
  swfVerify: readFileSync(new URL("../../prompts/swf/3-verify.user-prompt.md", import.meta.url), "utf8"),
  swfReview: readFileSync(new URL("../../prompts/swf/4-review.user-prompt.md", import.meta.url), "utf8"),
  swfPr: readFileSync(new URL("../../prompts/swf/5-pr.user-prompt.md", import.meta.url), "utf8"),
  swfNudge: readFileSync(new URL("../../prompts/swf/nudge.user-prompt.md", import.meta.url), "utf8"),
  swfContinue: readFileSync(new URL("../../prompts/swf/continue.user-prompt.md", import.meta.url), "utf8"),
  swfAnswer: readFileSync(new URL("../../prompts/swf/answer.user-prompt.md", import.meta.url), "utf8"),
  swfBadResult: readFileSync(new URL("../../prompts/swf/bad-result.user-prompt.md", import.meta.url), "utf8"),
  swfGateFailed: readFileSync(new URL("../../prompts/swf/gate-failed.user-prompt.md", import.meta.url), "utf8"),
  swfGateEscalate: readFileSync(new URL("../../prompts/swf/gate-escalate.user-prompt.md", import.meta.url), "utf8"),
};

/** Joins the lines of a wrapped paragraph: a line break followed by list indentation becomes one space. */
function unwrap(text: string): string {
  return text.replace(/(?<!\n)\n[ \t]*(?=\S)/g, " ");
}

/** The sentence of a step's prompt that tells the agent to invoke the step's skill `skill`. */
function invokeSkill(skill: string): string {
  return `Invoke the repository's skill \`${skill}\` (\`.claude/skills/${skill}/SKILL.md\`) first and follow it; it refines this step for the repository.`;
}

describe("session files", () => {
  it("composes the system prompt like the desktop's remote_system_prompt with an empty base, the swf steps after the shared parts", () => {
    const services = "\n### The repository's services\n- `api`: port 3000\n\n";
    const id = "7a1d0c2e-0000-4000-8000-000000000001";
    const sessionId = SessionId.of(id);
    const prompt = remoteSystemPrompt(prompts, sessionId, "## Working on a GitHub issue\n", services, "\n# Services\nStart api.\n\n");
    const sessions = prompts.sessions.replace("{{huntSessionId}}", id);
    const shared = `\n\n${prompts.remote}\n${prompts.gitPush}\n${prompts.question}\n${sessions}\n## Working on a GitHub issue\n`;
    const withServices = `${shared}\n### The repository's services\n- \`api\`: port 3000\n`;
    expect(prompt).toBe(`${withServices}\n### The repository's hunt.agent.md\n# Services\nStart api.\n`);
    expect(prompt.startsWith("\n\n## Remote session\n")).toBe(true);
    expect(prompt).toContain("follows at the end when it has one.\n\n### Git\n`origin` is the repository on GitHub.");
    expect(prompt).toContain("## Questions to the user\n\nWhen you end a turn because you need an answer only the user can give");
    expect(prompt).toContain(`## Other sessions in this worktree\n\nHunt keeps \`.hunt/sessions.md\``);
    expect(prompt).toContain(`Your own Hunt session id is \`${id}\`.`);
    expect(remoteSystemPrompt(prompts, sessionId, "## Working on a GitHub issue\n", services, null)).toBe(withServices);
    expect(remoteSystemPrompt(prompts, sessionId, "## Working on a GitHub issue\n", "", " \n")).toBe(shared);
    expect(remoteSystemPrompt(prompts, sessionId, "", null, null)).toBe(remoteSystemPrompt(prompts, sessionId, "", undefined, undefined));
  });

  it("fills the swf system prompt with the issue, the labels, the repository's question prefix and the protocol of the steps, without a branch", () => {
    const prompt = swfSystemPrompt(prompts.swfSystem, REPO, 12, WorkflowLabels.of("swf"), QUESTION_PREFIX);
    const unwrapped = unwrap(prompt);
    expect(
      unwrapped.startsWith(
        "## Working on a GitHub issue\n\nHunt's software factory started this session for issue #12 of acme/app, which carried the label `swf`, on a checkout of the " +
          "repository's default branch; the plan step creates the session's branch by the repository's branch naming rules, and every later step works on it.",
      ),
    ).toBe(true);
    expect(unwrapped).toContain(
      "The work runs as a pipeline of steps that Hunt drives: plan, implement, verify, review, pr, then checks (the pull request's checks and the decision of the " +
        "repository's review workflow), human-review (only when that workflow did not approve) and merge.",
    );
    expect(prompt).not.toContain("scorer");
    expect(unwrapped).toContain(
      "A finding of verify or of the review step at or above the step's `minSeverity` (hunt.json; a lesser one stays in the result as a suggestion), of the checks or of the merge brings you back to implement",
    );
    expect(unwrapped).toContain("Every step runs in a fresh conversation: what the earlier steps did is in `.hunt/swf/steps/<nn>-<step>.md` of the worktree");
    expect(unwrapped).toContain(
      "brings you back to implement with the finding in the prompt. Every step that sends you back has its own limit of returns, which the implement prompt names; " +
        "after it Hunt asks you to escalate to the people instead.",
    );
    expect(unwrapped).toContain(
      "Hunt reads the file once your turn ended and runs the step's gate on it: the checks of hunt.json's `checks` that the repository names for the step " +
        "(implement's gate is every check unless the repository says otherwise). A red check or a working tree that is not clean comes back to you in the same " +
        "conversation, and the step is not finished until its gate is green.",
    );
    expect(prompt).toContain("### How a step ends\n");
    expect(unwrapped).toContain("the file `.hunt/swf/result.md` in the worktree, which holds the human-readable part the step asks for");
    expect(unwrapped).toContain("the marker `<!-- hunt:step {…} -->` with the JSON object the step prescribes.");
    expect(unwrapped).toContain("Never post the result as a comment yourself");
    expect(unwrapped).toContain("a turn that ends with the issue still labelled `swf:<step>` and no `.hunt/swf/result.md` counts as unfinished work.");
    expect(prompt).toContain("### Questions to the people\n");
    expect(unwrapped).toContain(
      "put the repository's question prefix and a colon in front of the issue's title (`❓ RÜCKFRAGE: <title>`; `swf.questionPrefix` of its hunt.json) and " +
        "replace the step's label with `swf:question` in one command (the step's prompt names it as " +
        "`gh issue edit … --remove-label <step label> --add-label swf:question --title \"❓ RÜCKFRAGE: <title>\"`).",
    );
    expect(unwrapped).toContain("The comment starts with the question prefix in bold on a line of its own (`**❓ RÜCKFRAGE**`)");
    expect(unwrapped).not.toContain("German");
    expect(swfSystemPrompt(prompts.swfSystem, REPO, 12, WorkflowLabels.of("swf"), "❓ QUESTION")).toContain("--title \"❓ QUESTION: <title>\"");
    expect(unwrapped).toContain("(`gh issue view 12 --repo acme/app --json assignees -q '.assignees[].login'`) as `@login`");
    expect(unwrapped).toContain(
      "gather every open question into one short comment on the issue: a numbered list with one item per question, each saying in a sentence or two " +
        "what is to be decided, the options you see and your recommendation; leave out findings, background and notes that ask nothing.",
    );
    expect(unwrapped).toContain("End your turn with the same list as your last words and the marker `<!-- hunt:question -->`.");
    expect(prompt).toContain("### Giving up\n");
    expect(unwrapped).toContain("replace the step's label with `swf:failed` (the prompt names the command) and comment on the issue why.");
    expect(prompt).toContain("### Step skills\n");
    expect(unwrapped).toContain(
      "Every agent step has a Claude Code skill that the repository keeps in `.claude/skills/<name>/SKILL.md` and names in `swf.steps.<step>.skill` of " +
        "its hunt.json; Hunt has no default.",
    );
    expect(unwrapped).not.toContain("swf-<step>");
    expect(unwrapped).toContain("which review criteria to judge by");
    expect(unwrapped).toContain("one of the verify or review step becomes a finding");
    expect(unwrapped).not.toContain("attempt");
    expect(unwrapped).not.toContain("Claude review");
    expect(unwrapped).not.toContain("subagent");
    expect(unwrapped).not.toContain("A step without a skill");
    expect(prompt).toContain("### Guardrails\n");
    expect(prompt).not.toContain("swf:running");
    expect(prompt).not.toContain("{{");
  });

  it("writes hunt-session.json in the desktop's shape: a new conversation without permission requests, with the step's config options", () => {
    expect(JSON.parse(huntSessionFile(SessionId.of("ab12cd34-0000-4000-8000-000000000001"), "/home/agent/app", "PROMPT", {}))).toEqual({
      huntSessionId: "ab12cd34-0000-4000-8000-000000000001",
      acpSessionId: null,
      cwd: "/home/agent/app",
      systemPromptAppend: "PROMPT",
      modeId: "bypassPermissions",
      configOptions: {},
    });
    const pipeline = started(NOW, settingsWith({ plan: { model: "claude-opus-5-5", effort: "xhigh" } }));
    const file = huntSessionFile(SessionId.of("ab12cd34-0000-4000-8000-000000000001"), "/home/agent/app", "PROMPT", pipeline.configOptionsOf("plan"));
    expect(JSON.parse(file).configOptions).toEqual({ model: "claude-opus-5-5", effort: "xhigh" });
  });
});

describe("stepPrompt", () => {
  const labels = WorkflowLabels.of("swf");
  const fixLogin = { ...issue(12, "Fix login"), body: "The login fails." };

  it("gives the plan step the issue with every comment, the commands of its label and the task to create the branch", () => {
    const comments: CommentText[] = [
      { author: "bob", createdAt: "2026-10-13T09:00:00Z", body: "Also the logout.\n" },
      { author: "carol", createdAt: "2026-10-13T10:30:00Z", body: "Agreed." },
    ];
    const text = stepPrompt(prompts, REPO, fixLogin, comments, labels, started(NOW));
    const unwrapped = unwrap(text);

    expect(text.startsWith("Step `plan` for GitHub issue #12 of acme/app: Fix login\nhttps://github.com/acme/app/issues/12\n")).toBe(true);
    expect(text).toContain("## Issue, opened by @alice on 2026-10-13 08:04 UTC\n\nThe login fails.\n");
    expect(text).toContain("**@bob** on 2026-10-13 09:00 UTC:\n\nAlso the logout.\n\n---\n\n**@carol** on 2026-10-13 10:30 UTC:\n\nAgreed.");
    expect(unwrapped).toContain(
      "with `gh issue edit 12 --repo acme/app --remove-label swf:plan --add-label swf:question --title \"❓ RÜCKFRAGE: <title>\"` to mark the issue and " +
        "`gh issue edit 12 --repo acme/app --remove-label swf:question --add-label swf:plan --title \"<title>\"` once the answer arrived.",
    );
    expect(unwrapped).toContain("Write the step result to `.hunt/swf/result.md`: a short implementation plan");
    expect(unwrapped).toContain("work from `.hunt/swf/steps/01-plan.md`, where Hunt keeps it.");
    expect(unwrapped).toContain(
      "3. **Create the branch.** The worktree is a checkout of the repository's default branch. Create the session's branch from it, named for the issue by the " +
        "repository's branch naming rules (its guardrails and the step's skill say which;",
    );
    expect(unwrapped).toContain("switch to it and push it (`git push -u origin <branch>`). Every later step works on this branch.");
    expect(unwrapped).toContain(
      "The file ends with the line `<!-- hunt:step {\"step\":\"plan\",\"branch\":\"<the branch of step 3>\"} -->`; Hunt checks that the worktree is on that branch.",
    );
    expect(unwrapped).toContain(
      "The issue is labelled `swf:plan` while you work on this step; to give up, run `gh issue edit 12 --repo acme/app --remove-label swf:plan --add-label swf:failed` and say why.",
    );
    expect(text).not.toContain("Work on the branch");
    expect(text).not.toContain("{{");
  });

  it("says when the issue has no description or comments", () => {
    const text = stepPrompt(prompts, REPO, issue(3), [], labels, started(NOW));
    expect(text).toContain("(no description)");
    expect(text).toContain("## Comments\n\n(none)\n");
  });

  it("gives the implement step the findings to fix and the return of the step that sent it back, none for the first implementation", () => {
    const first = stepPrompt(prompts, REPO, fixLogin, [], labels, pipelineAt("implement"));
    const firstHeader = `Step \`implement\` for issue #12 of acme/app on the branch \`feat/general/12-fix-login\`.\n\n${invokeSkill("swf-implement")}\n\n`;
    expect(first.startsWith(`${firstHeader}## Findings to fix\n\n(none)\n`)).toBe(true);
    expect(unwrap(first)).toContain("`<!-- hunt:step {\"step\":\"implement\",\"summary\":\"<one sentence>\"} -->`");
    expect(unwrap(first)).toContain("The issue is labelled `swf:implement` while you work on this step.");
    expect(unwrap(first)).toContain("The checks of the step's gate run when you write the result; run them yourself first");
    expect(first).not.toContain("{{");

    const pipeline = sentBack(pipelineAt("verify"), ["Verify: the logout still fails", "Verify: no test\ncovers it"]);
    const fix = stepPrompt(prompts, REPO, fixLogin, [], labels, pipeline);
    expect(fix.startsWith("Step `implement` for issue #12 of acme/app on the branch `feat/general/12-fix-login` (return 1 of 5, sent back by verify).\n")).toBe(true);
    const review = sentBack(pipelineAt("review", { returns: { review: 1, verify: 3 } }), ["Review: a"]);
    expect(stepPrompt(prompts, REPO, fixLogin, [], labels, review)).toContain("(return 2 of 3, sent back by review).");
    expect(fix).toContain("## Findings to fix\n\n- Verify: the logout still fails\n- Verify: no test\n  covers it\n");
    expect(unwrap(fix)).toContain("with `gh issue edit 12 --repo acme/app --remove-label swf:implement --add-label swf:question --title \"❓ RÜCKFRAGE: <title>\"`");
  });

  it("asks the agent to escalate to the people once a step sent the change back more often than its limit", () => {
    const pipeline = sentBack(pipelineAt("checks", { returns: { checks: 2, verify: 1 }, pullRequest: 31 }), ["Checks: build failed"]);
    const text = stepPrompt(prompts, REPO, fixLogin, [], labels, pipeline);
    expect(text.startsWith("For issue #12 of acme/app, `checks` sent the change back to `implement` more than 2 times.\n")).toBe(true);
    expect(text).toContain("## The findings that came back last\n\n- Checks: build failed\n");
    expect(unwrap(text)).toContain("with `gh issue edit 12 --repo acme/app --remove-label swf:implement --add-label swf:question --title \"❓ RÜCKFRAGE: <title>\"` to mark the issue.");
    expect(unwrap(text)).toContain("run `gh issue edit 12 --repo acme/app --remove-label swf:question --add-label swf:implement --title \"<title>\"` and carry out the `implement` step");
    expect(text).not.toContain("{{");
  });

  it("gives the verify, review and pr steps their label, the branch and what they know of the pull request", () => {
    const verify = stepPrompt(prompts, REPO, fixLogin, [], labels, pipelineAt("verify"));
    expect(verify.startsWith("Step `verify` for issue #12 of acme/app on the branch `feat/general/12-fix-login`.\n")).toBe(true);
    expect(verify).toContain("`<!-- hunt:step {\"step\":\"verify\",\"findings\":[{\"text\":\"<what is wrong and where>\",\"severity\":<1-5>}, \"…\"]} -->`");
    expect(unwrap(verify)).toContain("Hunt sends back to implement only the findings at or above the repository's `minSeverity` for this step (`swf.steps.verify.minSeverity` of hunt.json, 3 without it)");
    expect(unwrap(verify)).toContain("The issue is labelled `swf:verify` while you work on this step.");
    expect(unwrap(verify)).toContain("The review step that follows reads the diff as a reviewer");
    expect(verify).not.toContain("3. Read the whole diff");
    expect(verify).not.toContain("hunt-ctl check");
    expect(unwrap(verify)).toContain("The gate of the implement step ran the repository's checks on the change already.");

    const review = stepPrompt(prompts, REPO, fixLogin, [], labels, pipelineAt("review"));
    expect(review.startsWith("Step `review` for issue #12 of acme/app on the branch `feat/general/12-fix-login` (pull request: (not opened yet)).\n")).toBe(true);
    expect(unwrap(review)).toContain("This conversation is fresh: you did not write the change");
    expect(unwrap(review)).toContain("Read the diff of the branch against its base branch (`git diff origin/<base>...HEAD` and the untracked files)");
    expect(unwrap(review)).toContain("(`gh issue view 12 --repo acme/app --comments`)");
    expect(unwrap(review)).toContain("the plan and the step results in `.hunt/swf/steps/`");
    expect(unwrap(review)).toContain("when the pull request exists already, also the comments on it");
    expect(unwrap(review)).toContain("Do not fix anything in this step.");
    expect(unwrap(review)).toContain("`<!-- hunt:step {\"step\":\"review\",\"findings\":[{\"text\":\"<file>: <what is wrong>\",\"severity\":<1-5>}, \"…\"]} -->` — an empty list when the change is clean.");
    expect(review).toContain("| 3 | a violation of a repository guardrail, or a test the guardrails demand but the change lacks |");
    expect(unwrap(review)).toContain("Hunt sends back to implement only the findings at or above the repository's `minSeverity` for this step (`swf.steps.review.minSeverity` of hunt.json, 3 without it)");
    expect(review).not.toContain("a suggestion only when the implement step can act on it");
    expect(unwrap(review)).toContain("to give up, run `gh issue edit 12 --repo acme/app --remove-label swf:review --add-label swf:failed` and say why.");
    expect(review).not.toContain("humanReview");
    const rereview = stepPrompt(prompts, REPO, fixLogin, [], labels, pipelineAt("review", { pullRequest: 31 }));
    expect(rereview).toContain("(pull request: #31)");

    const pr = stepPrompt(prompts, REPO, fixLogin, [], labels, pipelineAt("pr"));
    expect(pr.startsWith("Step `pr` for issue #12 of acme/app on the branch `feat/general/12-fix-login`.\n")).toBe(true);
    expect(unwrap(pr)).toContain("contains `Closes #12`");
    expect(unwrap(pr)).toContain("The plan in `.hunt/swf/steps/01-plan.md`, the results of the implement and verify runs beside it");
    expect(pr).toContain("`<!-- hunt:step {\"step\":\"pr\",\"pullRequest\":<number>} -->`");
    expect(unwrap(pr)).toContain("its checks and the repository's review workflow run on GitHub; that workflow decides whether a person reviews before Hunt merges it.");
    expect(pr).not.toContain("scorer");
    expect(pr).not.toContain("conventional commit");
    expect(pr).not.toContain("a person reviews before the merge:");
    expect(pr).not.toContain("gate");
    for (const text of [verify, review, rereview, pr]) {
      expect(text).not.toContain("{{");
    }
  });

  it("has no prompt for the steps the poller carries out itself", () => {
    for (const step of ["checks", "human-review", "merge"] as const) {
      expect(() => stepPrompt(prompts, REPO, fixLogin, [], labels, pipelineAt(step))).toThrow(`the step ${step} has no prompt for the agent`);
    }
  });

  it("tells the agent to invoke the skill of every agent step first", () => {
    const plan = stepPrompt(prompts, REPO, fixLogin, [], labels, started(NOW));
    expect(plan).toContain(`https://github.com/acme/app/issues/12\n\n${invokeSkill("swf-plan")}\n\n## Issue, opened by @alice`);
    for (const step of ["implement", "verify", "review", "pr"] as const) {
      expect(stepPrompt(prompts, REPO, fixLogin, [], labels, pipelineAt(step)), step).toContain(`.\n\n${invokeSkill(`swf-${step}`)}\n\n`);
    }
  });

  it("names the skill hunt.json sets for each step in its prompt", () => {
    const settings = settingsWith({ plan: { skill: "acme-plan" }, implement: { skill: "acme-implement" }, review: { skill: "acme-review" } });
    expect(stepPrompt(prompts, REPO, fixLogin, [], labels, started(NOW, settings))).toContain(`issues/12\n\n${invokeSkill("acme-plan")}\n`);
    expect(stepPrompt(prompts, REPO, fixLogin, [], labels, pipelineAt("review", { settings }))).toContain(`.\n\n${invokeSkill("acme-review")}\n\n`);
    for (const step of ["verify", "pr"] as const) {
      expect(stepPrompt(prompts, REPO, fixLogin, [], labels, pipelineAt(step, { settings })), step).toContain(invokeSkill(SKILLS[step]));
    }
    expect(stepPrompt(prompts, REPO, fixLogin, [], labels, sentBack(pipelineAt("verify", { settings }), ["Verify: a"]))).toContain(
      `\`feat/general/12-fix-login\` (return 1 of 5, sent back by verify).\n\n${invokeSkill("acme-implement")}\n\n## Findings to fix`,
    );
    const escalate = sentBack(pipelineAt("checks", { settings, returns: { checks: 2 }, pullRequest: 31 }), ["Checks: build failed"]);
    expect(stepPrompt(prompts, REPO, fixLogin, [], labels, escalate)).toContain(
      `your recommendation.\n\n${invokeSkill("acme-implement")}\n\n## The findings`,
    );
  });
});

describe("gatePrompt", () => {
  const labels = WorkflowLabels.of("swf");
  const lint: GateFailure = { name: "lint", exitCode: 1, output: "src/a.ts\n  3:1  error  no-unused-vars\n" };

  /** The implement pipeline after `failures` failures of its gate, with `maxGateRuns`. */
  function failedGate(failures: number, maxGateRuns = 5): Pipeline {
    const pipeline = pipelineAt("implement", { settings: settingsWith({}, maxGateRuns) });
    for (let run = 1; run <= failures; run++) {
      pipeline.noteGateFailure(run);
    }
    return pipeline;
  }

  it("gives the agent its result back with the failed checks, the gate run and its limit", () => {
    const text = gatePrompt(prompts, labels, failedGate(2), [lint, { name: "test", exitCode: null, output: "" }]);
    const unwrapped = unwrap(text);
    expect(unwrapped.startsWith("Hunt ran the gate of the step `implement` on your result, the checks of hunt.json's `checks` that the repository names for the step, and these failed:")).toBe(true);
    expect(text).toContain("### lint (exit 1)\n\n```\nsrc/a.ts\n  3:1  error  no-unused-vars\n```\n\n### test (no exit code)\n\n(no output)\n");
    expect(unwrapped).toContain("a failing check is yours, also a flaky test or a warning");
    expect(unwrapped).toContain("This does not count as a return to `implement`: it is gate run 2 of 5, after which Hunt asks you to escalate to the people.");
    expect(text).not.toContain("{{");
  });

  it("quotes the last 80 lines of a check's output in a fence longer than its backtick runs", () => {
    const output = Array.from({ length: 100 }, (_line, index) => `line ${index + 1}`).join("\n") + "\n``` in the output\n";
    const text = gatePrompt(prompts, labels, failedGate(1), [{ name: "test", exitCode: 2, output }]);
    expect(text).toContain("### test (exit 2)\n\n````\nline 22\n");
    expect(text).toContain("line 100\n``` in the output\n````\n");
    expect(text).not.toContain("line 21\n");
  });

  it("names the files the checks left dirty as a failure of its own", () => {
    const failures: GateFailure[] = [{ ...lint, dirty: ["src/a.ts"] }, { name: "format", exitCode: 0, output: "formatted 2 files", dirty: ["src/a.ts", "src/b.ts"] }];
    const text = gatePrompt(prompts, labels, failedGate(1), failures);
    expect(text).toContain("### lint (exit 1)\n");
    expect(text).not.toContain("### format");
    expect(text).toContain("```\n\n### working tree not clean after the checks\n\n- `src/a.ts`\n- `src/b.ts`\n");
  });

  it("asks the agent to escalate once the result failed more often than maxGateRuns, with the question command", () => {
    const text = gatePrompt(prompts, labels, failedGate(3, 2), [lint]);
    const unwrapped = unwrap(text);
    expect(unwrapped.startsWith("The gate of the step `implement` failed on your result more than 2 times. Stop fixing it on your own")).toBe(true);
    expect(unwrapped).toContain("with `gh issue edit 12 --repo acme/app --remove-label swf:implement --add-label swf:question --title \"❓ RÜCKFRAGE: <title>\"` to mark the issue.");
    expect(text).toContain("## The checks that failed last\n\n### lint (exit 1)\n");
    expect(unwrapped).toContain("run `gh issue edit 12 --repo acme/app --remove-label swf:question --add-label swf:implement --title \"<title>\"`");
    expect(unwrapped).toContain("To give up instead, run `gh issue edit 12 --repo acme/app --remove-label swf:implement --add-label swf:failed` and say why.");
    expect(text).not.toContain("{{");
    expect(unwrap(gatePrompt(prompts, labels, failedGate(2, 2), [lint]))).toContain("it is gate run 2 of 2, after which");
  });

  it("has no gate at the steps of the poller", () => {
    expect(() => gatePrompt(prompts, labels, pipelineAt("checks", { pullRequest: 31 }), [lint])).toThrow("the step checks has no gate");
  });
});

describe("answerPrompt", () => {
  it("brings the answers to the agent and names the command that takes the label back to the step", () => {
    const answers: CommentText[] = [
      { author: "bob", createdAt: "2026-10-13T10:05:00Z", body: "Postgres.\n" },
      { author: "carol", createdAt: "2026-10-13T10:10:00Z", body: "With pgvector." },
    ];
    const text = answerPrompt(prompts.swfAnswer, REPO, answers, WorkflowLabels.of("swf"), pipelineAt("implement"));
    expect(text.startsWith("An answer to your question arrived as a comment on issue #12 of acme/app:\n\n**@bob** on 2026-10-13 10:05 UTC:\n\nPostgres.\n\n---\n\n**@carol** on 2026-10-13 10:10 UTC:\n\nWith pgvector.\n\n")).toBe(true);
    expect(unwrap(text)).toContain(
      "Replace `swf:question` with `swf:implement` and take the question prefix `❓ RÜCKFRAGE: ` off the title " +
        "(`gh issue edit 12 --repo acme/app --remove-label swf:question --add-label swf:implement --title \"<title>\"`), " +
        "then finish the step `implement` you stopped at and write its result to `.hunt/swf/result.md`.",
    );
    expect(text).not.toContain("{{");
  });
});

describe("nudgePrompt", () => {
  it("names the step, the three ways out and the consequence of ending the turn again", () => {
    const text = nudgePrompt(prompts.swfNudge, REPO, WorkflowLabels.of("swf"), pipelineAt("verify"));
    const unwrapped = unwrap(text);
    expect(unwrapped.startsWith(
      "Your last turn ended, but issue #12 of acme/app still has the label `swf:verify`: no result for the step `verify` was written to `.hunt/swf/result.md` and neither `swf:question` nor `swf:failed` is set.",
    )).toBe(true);
    expect(text).toContain("`<!-- hunt:step {\"step\":\"verify\", …} -->`");
    expect(unwrapped).toContain("(`gh issue edit 12 --repo acme/app --remove-label swf:verify --add-label swf:question --title \"❓ RÜCKFRAGE: <title>\"`)");
    expect(text).toContain("(`gh issue edit 12 --repo acme/app --remove-label swf:verify --add-label swf:failed`)");
    expect(text.endsWith("When this turn ends with the issue still labelled `swf:verify` and no result, Hunt marks the issue as failed.\n")).toBe(true);
    expect(text).not.toContain("{{");
  });
});

describe("continuePrompt", () => {
  it("names the issue and the step and sends the agent on to the step's result", () => {
    const text = continuePrompt(prompts.swfContinue, REPO, WorkflowLabels.of("swf"), pipelineAt("implement"));
    expect(unwrap(text).startsWith("Your turn of the step `implement` for issue #12 of acme/app ended before you finished it:")).toBe(true);
    expect(text).toContain("`<!-- hunt:step {\"step\":\"implement\", …} -->`");
    expect(text).not.toContain("{{");
  });
});

describe("badResultPrompt", () => {
  it("tells the agent why its step result is unusable and how to write it again", () => {
    expect(badResultPrompt(prompts.swfBadResult, "findings of a verify result must be a list")).toBe(
      "Hunt could not read your step result in `.hunt/swf/result.md`: findings of a verify result must be a list. " +
        "Write the step's result to `.hunt/swf/result.md` again, with a valid `<!-- hunt:step {…} -->` marker on a line of its own.",
    );
  });
});
