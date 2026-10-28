import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type * as z from "zod/mini";
import { Repository } from "../../../../libs/domain/src/session/repository.value-object.ts";
import { SessionId } from "../../../../libs/domain/src/session/session-id.value-object.ts";
import type { SwfStep } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import { WorkflowLabels } from "../../../../libs/domain/src/swf/workflow-labels.value-object.ts";
import type { Issue, IssueComment } from "./github.client.ts";
import { Pipeline } from "./pipeline.domain.ts";
import { answerPrompt, badResultPrompt, huntSessionFile, nudgePrompt, remoteSystemPrompt, stepPrompt, swfSystemPrompt } from "./swf-prompts.utils.ts";
import { SKILLS } from "./swf.fixtures.ts";

const REPO = Repository.fromSlug("acme/app");

function issue(number: number, title = `Issue ${number}`, labels = ["swf"]): Issue {
  return { number, title, body: "", author: "alice", createdAt: "2026-10-13T08:04:05Z", url: `https://github.com/acme/app/issues/${number}`, labels, state: "open", assignees: [] };
}

/** A fresh pipeline at `step`, apart from `fields`. */
function pipelineAt(step: SwfStep, fields: Partial<z.input<typeof Pipeline.schema>> = {}): Pipeline {
  return new Pipeline({ ...Pipeline.start([], SKILLS).toJSON(), step, ...fields });
}

/** `pipeline` after `findings` sent it back to implement. */
function sentBack(pipeline: Pipeline, findings: string[]): Pipeline {
  pipeline.sendBackToImplement(findings);
  return pipeline;
}

const prompts = {
  remote: readFileSync(new URL("../../../../libs/domain/prompts/remote.system-prompt.md", import.meta.url), "utf8"),
  gitPush: readFileSync(new URL("../../../../libs/domain/prompts/git-push.system-prompt.md", import.meta.url), "utf8"),
  question: readFileSync(new URL("../../../../libs/domain/prompts/question.system-prompt.md", import.meta.url), "utf8"),
  sessions: readFileSync(new URL("../../../../libs/domain/prompts/sessions.system-prompt.md", import.meta.url), "utf8"),
  swfSystem: readFileSync(new URL("../../software-factory/0-system-prompt.md", import.meta.url), "utf8"),
  swfPlan: readFileSync(new URL("../../software-factory/1-plan.user-prompt.md", import.meta.url), "utf8"),
  swfImplement: readFileSync(new URL("../../software-factory/2-implement.user-prompt.md", import.meta.url), "utf8"),
  swfEscalate: readFileSync(new URL("../../software-factory/2-implement-escalate.user-prompt.md", import.meta.url), "utf8"),
  swfVerify: readFileSync(new URL("../../software-factory/3-verify.user-prompt.md", import.meta.url), "utf8"),
  swfGate: readFileSync(new URL("../../software-factory/4-gate.user-prompt.md", import.meta.url), "utf8"),
  swfPr: readFileSync(new URL("../../software-factory/5-pr.user-prompt.md", import.meta.url), "utf8"),
  swfNudge: readFileSync(new URL("../../software-factory/nudge.user-prompt.md", import.meta.url), "utf8"),
  swfAnswer: readFileSync(new URL("../../software-factory/answer.user-prompt.md", import.meta.url), "utf8"),
  swfBadResult: readFileSync(new URL("../../software-factory/bad-result.user-prompt.md", import.meta.url), "utf8"),
};

/** Joins the lines of a wrapped paragraph: a line break followed by list indentation becomes one space. */
function unwrap(text: string): string {
  return text.replace(/(?<!\n)\n[ \t]*(?=\S)/g, " ");
}

/** `text` with the markers of its block quotes removed, unwrapped. */
function unquote(text: string): string {
  return unwrap(text.replace(/^> /gm, ""));
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

  it("fills the swf system prompt with the issue, the branch, the labels and the protocol of the steps", () => {
    const prompt = swfSystemPrompt(prompts.swfSystem, REPO, 12, "feat/general/12-fix-login", WorkflowLabels.of("swf"));
    const unwrapped = unwrap(prompt);
    expect(
      unwrapped.startsWith(
        "## Working on a GitHub issue\n\nHunt's poller started this session for issue #12 of acme/app, which carried the label `swf`, on the branch `feat/general/12-fix-login`.",
      ),
    ).toBe(true);
    expect(unwrapped).toContain(
      "The work runs as a pipeline of steps that the poller drives: plan, implement, verify, gate, pr, then review (the pull request's checks and the Claude review), " +
        "human-review (only when the gate asked for a person) and merge.",
    );
    expect(unwrapped).toContain("brings you back to implement with the finding in the prompt, at most 5 times; after that the poller asks you to escalate to the people instead.");
    expect(prompt).toContain("### How a step ends\n");
    expect(unwrapped).toContain("one comment on the issue (`gh issue comment 12 --repo acme/app --body-file <file>`)");
    expect(unwrapped).toContain("the marker `<!-- hunt:step {…} -->` with the JSON object the step prescribes.");
    expect(unwrapped).toContain("a turn that ends with the issue still labelled `swf:<step>` and no result counts as unfinished work.");
    expect(prompt).toContain("### Questions to the people\n");
    expect(unwrapped).toContain(
      "replace the step's label with `swf:question` in one command (the step's prompt names it as " +
        "`gh issue edit … --remove-label <step label> --add-label swf:question --title \"❓ RÜCKFRAGE: <title>\"`).",
    );
    expect(unwrapped).toContain("(`gh issue view 12 --repo acme/app --json assignees -q '.assignees[].login'`) as `@login`");
    expect(unwrapped).toContain("End your turn with the questions as your last words and the marker `<!-- hunt:question -->`.");
    expect(prompt).toContain("### Giving up\n");
    expect(unwrapped).toContain("replace the step's label with `swf:failed` (the prompt names the command) and comment on the issue why.");
    expect(prompt).toContain("### Step skills\n");
    expect(unwrapped).toContain(
      "Every agent step has a Claude Code skill that the repository keeps in `.claude/skills/<name>/SKILL.md` and names under `swf.skills` of " +
        "its hunt.json by the step; Hunt has no default.",
    );
    expect(unwrapped).not.toContain("swf-<step>");
    expect(unwrapped).toContain("which the gate's prompt hands to its judging subagent instead.");
    expect(unwrapped).not.toContain("A step without a skill");
    expect(prompt).toContain("### Guardrails\n");
    expect(prompt).not.toContain("swf:running");
    expect(prompt).not.toContain("{{");
  });

  it("writes hunt-session.json in the desktop's shape: a new conversation without permission requests, with the model of hunt.json", () => {
    expect(JSON.parse(huntSessionFile(SessionId.of("ab12cd34-0000-4000-8000-000000000001"), "/home/agent/app", "PROMPT", null))).toEqual({
      huntSessionId: "ab12cd34-0000-4000-8000-000000000001",
      acpSessionId: null,
      cwd: "/home/agent/app",
      systemPromptAppend: "PROMPT",
      modeId: "bypassPermissions",
      configOptions: {},
    });
    expect(JSON.parse(huntSessionFile(SessionId.of("ab12cd34-0000-4000-8000-000000000001"), "/home/agent/app", "PROMPT", "claude-opus-5-5")).configOptions).toEqual({ model: "claude-opus-5-5" });
  });
});

describe("stepPrompt", () => {
  const labels = WorkflowLabels.of("swf");
  const branch = "feat/general/12-fix-login";
  const fixLogin = { ...issue(12, "Fix login"), body: "The login fails." };

  it("gives the plan step the issue with every comment, the branch and the commands of its label", () => {
    const comments: IssueComment[] = [
      { id: 1, author: "bob", createdAt: "2026-10-13T09:00:00Z", body: "Also the logout.\n" },
      { id: 2, author: "carol", createdAt: "2026-10-13T10:30:00Z", body: "Agreed." },
    ];
    const text = stepPrompt(prompts, REPO, fixLogin, comments, branch, labels, Pipeline.start([], SKILLS));
    const unwrapped = unwrap(text);

    expect(text.startsWith("Step `plan` for GitHub issue #12 of acme/app: Fix login\nhttps://github.com/acme/app/issues/12\n")).toBe(true);
    expect(text).toContain("## Issue, opened by @alice on 2026-10-13 08:04 UTC\n\nThe login fails.\n");
    expect(text).toContain("**@bob** on 2026-10-13 09:00 UTC:\n\nAlso the logout.\n\n---\n\n**@carol** on 2026-10-13 10:30 UTC:\n\nAgreed.");
    expect(unwrapped).toContain(
      "with `gh issue edit 12 --repo acme/app --remove-label swf:plan --add-label swf:question --title \"❓ RÜCKFRAGE: <title>\"` to mark the issue and " +
        "`gh issue edit 12 --repo acme/app --remove-label swf:question --add-label swf:plan --title \"<title>\"` once the answer arrived.",
    );
    expect(unwrapped).toContain("The comment ends with the line `<!-- hunt:step {\"step\":\"plan\"} -->`.");
    expect(unwrapped).toContain(
      "Work on the branch `feat/general/12-fix-login`. The issue is labelled `swf:plan` while you work on this step; to give up, run " +
        "`gh issue edit 12 --repo acme/app --remove-label swf:plan --add-label swf:failed` and say why.",
    );
    expect(text).not.toContain("{{");
  });

  it("says when the issue has no description or comments", () => {
    const text = stepPrompt(prompts, REPO, issue(3), [], "feat/general/3-issue-3", labels, Pipeline.start([], SKILLS));
    expect(text).toContain("(no description)");
    expect(text).toContain("## Comments\n\n(none)\n");
  });

  it("gives the implement step the findings to fix and the attempt, none for the first implementation", () => {
    const first = stepPrompt(prompts, REPO, fixLogin, [], branch, labels, pipelineAt("implement"));
    const firstHeader = `Step \`implement\` for issue #12 of acme/app on the branch \`feat/general/12-fix-login\`.\n\n${invokeSkill("swf-implement")}\n\n`;
    expect(first.startsWith(`${firstHeader}## Findings to fix\n\n(none)\n`)).toBe(true);
    expect(unwrap(first)).toContain("`<!-- hunt:step {\"step\":\"implement\",\"summary\":\"<one sentence>\"} -->`");
    expect(unwrap(first)).toContain("The issue is labelled `swf:implement` while you work on this step.");
    expect(first).not.toContain("{{");

    const pipeline = sentBack(pipelineAt("verify"), ["Verify: the logout still fails", "Verify: no test\ncovers it"]);
    const fix = stepPrompt(prompts, REPO, fixLogin, [], branch, labels, pipeline);
    expect(fix).toContain("(attempt 1 of 5)");
    expect(fix).toContain("## Findings to fix\n\n- Verify: the logout still fails\n- Verify: no test\n  covers it\n");
    expect(unwrap(fix)).toContain("with `gh issue edit 12 --repo acme/app --remove-label swf:implement --add-label swf:question --title \"❓ RÜCKFRAGE: <title>\"`");
  });

  it("asks the agent to escalate to the people once the issue went back to implement more than five times", () => {
    const pipeline = sentBack(pipelineAt("review", { attempt: 5, pullRequest: 31 }), ["Checks: build failed"]);
    const text = stepPrompt(prompts, REPO, fixLogin, [], branch, labels, pipeline);
    expect(text.startsWith("Issue #12 of acme/app went back to `implement` more than 5 times.")).toBe(true);
    expect(text).toContain("## The findings that came back last\n\n- Checks: build failed\n");
    expect(unwrap(text)).toContain("with `gh issue edit 12 --repo acme/app --remove-label swf:implement --add-label swf:question --title \"❓ RÜCKFRAGE: <title>\"` to mark the issue.");
    expect(unwrap(text)).toContain("run `gh issue edit 12 --repo acme/app --remove-label swf:question --add-label swf:implement --title \"<title>\"` and carry out the `implement` step");
    expect(text).not.toContain("{{");
  });

  it("gives the verify, gate and pr steps their label, the branch and what they know of the pull request", () => {
    const verify = stepPrompt(prompts, REPO, fixLogin, [], branch, labels, pipelineAt("verify"));
    expect(verify.startsWith("Step `verify` for issue #12 of acme/app on the branch `feat/general/12-fix-login`.\n")).toBe(true);
    expect(verify).toContain("`<!-- hunt:step {\"step\":\"verify\",\"findings\":[\"<finding>\", \"…\"]} -->`");
    expect(unwrap(verify)).toContain("The issue is labelled `swf:verify` while you work on this step.");

    const gate = stepPrompt(prompts, REPO, fixLogin, [], branch, labels, pipelineAt("gate"));
    expect(gate.startsWith("Step `gate` for issue #12 of acme/app on the branch `feat/general/12-fix-login` (pull request: (not opened yet)).\n")).toBe(true);
    expect(unwrap(gate)).toContain("Read the diff of the branch `feat/general/12-fix-login` against its base branch");
    expect(unwrap(gate)).toContain("(`gh issue view 12 --repo acme/app --comments`)");
    expect(unwrap(gate)).toContain("to give up, run `gh issue edit 12 --repo acme/app --remove-label swf:gate --add-label swf:failed` and say why.");
    const regate = stepPrompt(prompts, REPO, fixLogin, [], branch, labels, pipelineAt("gate", { pullRequest: 31 }));
    expect(regate).toContain("(pull request: #31)");

    const pr = stepPrompt(prompts, REPO, fixLogin, [], branch, labels, pipelineAt("pr"));
    expect(pr.startsWith("Step `pr` for issue #12 of acme/app on the branch `feat/general/12-fix-login` (a person reviews before the merge: no).\n")).toBe(true);
    expect(pr).toContain("contains `Closes #12`");
    expect(pr).toContain("`<!-- hunt:step {\"step\":\"pr\",\"pullRequest\":<number>} -->`");
    expect(stepPrompt(prompts, REPO, fixLogin, [], branch, labels, pipelineAt("pr", { humanReview: true }))).toContain("(a person reviews before the merge: yes)");
    for (const text of [verify, gate, regate, pr]) {
      expect(text).not.toContain("{{");
    }
  });

  it("has no prompt for the steps the poller carries out itself", () => {
    for (const step of ["review", "human-review", "merge"] as const) {
      expect(() => stepPrompt(prompts, REPO, fixLogin, [], branch, labels, pipelineAt(step))).toThrow(`the step ${step} has no prompt for the agent`);
    }
  });

  it("tells the agent to invoke the skill of every step but gate first, and hands the gate's skill to the judging subagent as the rubric", () => {
    const plan = stepPrompt(prompts, REPO, fixLogin, [], branch, labels, Pipeline.start([], SKILLS));
    expect(plan).toContain(`https://github.com/acme/app/issues/12\n\n${invokeSkill("swf-plan")}\n\n## Issue, opened by @alice`);
    for (const step of ["implement", "verify", "pr"] as const) {
      expect(stepPrompt(prompts, REPO, fixLogin, [], branch, labels, pipelineAt(step)), step).toContain(`.\n\n${invokeSkill(`swf-${step}`)}\n\n`);
    }
    const gate = stepPrompt(prompts, REPO, fixLogin, [], branch, labels, pipelineAt("gate"));
    expect(unquote(gate)).toContain(
      "and the repository's rubric for the review necessity, its skill `swf-gate` (`.claude/skills/swf-gate/SKILL.md`), and judge by that rubric. " +
        'Answer with exactly one JSON object `{"humanReview": true|false, "risk": "low"|"medium"|"high", "reasons": ["…"]}`',
    );
    expect(gate).not.toContain("Invoke the repository's skill");
    expect(gate).not.toContain("When the repository has no rubric");
    expect(gate).not.toContain("hunt.agent.md");
  });

  it("names the skill hunt.json sets for each step in its prompt", () => {
    const skills = { ...SKILLS, plan: "acme-plan", implement: "acme-implement", gate: "acme-gate" };
    expect(stepPrompt(prompts, REPO, fixLogin, [], branch, labels, Pipeline.start([], skills))).toContain(`issues/12\n\n${invokeSkill("acme-plan")}\n`);
    expect(unquote(stepPrompt(prompts, REPO, fixLogin, [], branch, labels, pipelineAt("gate", { skills })))).toContain(
      "its skill `acme-gate` (`.claude/skills/acme-gate/SKILL.md`), and judge by that rubric.",
    );
    for (const step of ["verify", "pr"] as const) {
      expect(stepPrompt(prompts, REPO, fixLogin, [], branch, labels, pipelineAt(step, { skills })), step).toContain(invokeSkill(`swf-${step}`));
    }
    expect(stepPrompt(prompts, REPO, fixLogin, [], branch, labels, sentBack(pipelineAt("verify", { skills }), ["Verify: a"]))).toContain(
      `\`feat/general/12-fix-login\` (attempt 1 of 5).\n\n${invokeSkill("acme-implement")}\n\n## Findings to fix`,
    );
    const escalate = sentBack(pipelineAt("review", { skills, attempt: 5 }), ["Checks: build failed"]);
    expect(stepPrompt(prompts, REPO, fixLogin, [], branch, labels, escalate)).toContain(
      `with your recommendation.\n\n${invokeSkill("acme-implement")}\n\n## The findings`,
    );
  });
});

describe("answerPrompt", () => {
  it("brings the answers to the agent and names the command that takes the label back to the step", () => {
    const answers: IssueComment[] = [
      { id: 4, author: "bob", createdAt: "2026-10-13T10:05:00Z", body: "Postgres.\n" },
      { id: 5, author: "carol", createdAt: "2026-10-13T10:10:00Z", body: "With pgvector." },
    ];
    const text = answerPrompt(prompts.swfAnswer, REPO, 12, answers, WorkflowLabels.of("swf"), "implement");
    expect(text.startsWith("An answer to your question arrived as a comment on issue #12 of acme/app:\n\n**@bob** on 2026-10-13 10:05 UTC:\n\nPostgres.\n\n---\n\n**@carol** on 2026-10-13 10:10 UTC:\n\nWith pgvector.\n\n")).toBe(true);
    expect(unwrap(text)).toContain(
      "Replace `swf:question` with `swf:implement` and remove the red question mark and the word for a question back from the title " +
        "(`gh issue edit 12 --repo acme/app --remove-label swf:question --add-label swf:implement --title \"<title>\"`), " +
        "then finish the step `implement` you stopped at and post its result.",
    );
    expect(text).not.toContain("{{");
  });
});

describe("nudgePrompt", () => {
  it("names the step, the three ways out and the consequence of ending the turn again", () => {
    const text = nudgePrompt(prompts.swfNudge, REPO, 12, WorkflowLabels.of("swf"), "verify");
    const unwrapped = unwrap(text);
    expect(unwrapped.startsWith(
      "Your last turn ended, but issue #12 of acme/app still has the label `swf:verify`: no result for the step `verify` was commented on it and neither `swf:question` nor `swf:failed` is set.",
    )).toBe(true);
    expect(text).toContain("`<!-- hunt:step {\"step\":\"verify\", …} -->`");
    expect(unwrapped).toContain("(`gh issue edit 12 --repo acme/app --remove-label swf:verify --add-label swf:question --title \"❓ RÜCKFRAGE: <title>\"`)");
    expect(text).toContain("(`gh issue edit 12 --repo acme/app --remove-label swf:verify --add-label swf:failed`)");
    expect(text.endsWith("When this turn ends with the issue still labelled `swf:verify` and no result, Hunt marks the issue as failed.\n")).toBe(true);
    expect(text).not.toContain("{{");
  });
});

describe("badResultPrompt", () => {
  it("tells the agent why its step result is unusable and how to post it again", () => {
    expect(badResultPrompt(prompts.swfBadResult, "findings of a verify result must be a list")).toBe(
      "Hunt could not read your step result: findings of a verify result must be a list. Post the step's result again as a comment with a valid `<!-- hunt:step {…} -->` marker.",
    );
  });
});
