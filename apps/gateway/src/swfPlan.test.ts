import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Issue } from "./github.ts";
import {
  activeSessionVms,
  agentStateOf,
  branchName,
  claimComment,
  failureComment,
  fillPrompt,
  firstPrompt,
  huntSessionFile,
  issuesToStart,
  nudgePrompt,
  redact,
  remoteSystemPrompt,
  sessionNames,
  swfSystemPrompt,
  slugify,
  stoppedComment,
  swfLabels,
} from "./swfPlan.ts";

function issue(number: number, title = `Issue ${number}`, labels = ["swf"]): Issue {
  return { number, title, body: "", author: "alice", createdAt: "2026-10-13T08:04:05Z", url: `https://github.com/acme/app/issues/${number}`, labels, state: "open" };
}

describe("names", () => {
  it("slugifies titles to at most 40 lowercase ASCII characters without dangling dashes", () => {
    expect(slugify("Fix login, then logout!")).toBe("fix-login-then-logout");
    expect(slugify("Übersetzung für Ärzte & Co.")).toBe("ubersetzung-fur-arzte-co");
    expect(slugify("  --Hello__World--  ")).toBe("hello-world");
    expect(slugify("A".repeat(30) + " " + "b".repeat(30))).toBe(`${"a".repeat(30)}-${"b".repeat(9)}`);
    expect(slugify(`${"a".repeat(39)} tail`)).toBe("a".repeat(39));
    expect(slugify("日本語")).toBe("");
  });

  it("names the branch feat/general/<issue>-<slug>, or feat/general/<issue> without a usable title", () => {
    expect(branchName(issue(12, "Fix login"))).toBe("feat/general/12-fix-login");
    expect(branchName(issue(7, "!!!"))).toBe("feat/general/7");
    expect(branchName(issue(8, "Add export", []))).toBe("feat/general/8-add-export");
  });

  it("names the branch of an issue labelled bug, in any case, fix/general/<issue>-<slug>", () => {
    expect(branchName(issue(12, "Fix login", ["swf", "bug"]))).toBe("fix/general/12-fix-login");
    expect(branchName(issue(13, "Crash", ["Bug"]))).toBe("fix/general/13-crash");
    expect(branchName(issue(14, "!!!", ["bug"]))).toBe("fix/general/14");
    expect(branchName(issue(15, "Debug view", ["swf", "debug", "bugfix"]))).toBe("feat/general/15-debug-view");
  });

  it("takes the short ID and the VM name from the first 8 hex digits of the session ID", () => {
    expect(sessionNames("AB12CD34-0000-4000-8000-000000000001")).toEqual({
      id: "AB12CD34-0000-4000-8000-000000000001",
      short: "ab12cd34",
      vm: "vm-hunt-s-ab12cd34",
    });
  });

  it("derives the labels of a run from the configured label", () => {
    expect(swfLabels("swf")).toEqual({ requested: "swf", running: "swf:running", question: "swf:question", done: "swf:done", failed: "swf:failed" });
  });
});

describe("agentStateOf", () => {
  const labels = swfLabels("swf");

  it("reads the agent's state from the issue's labels, a question first", () => {
    expect(agentStateOf({ state: "open", labels: ["swf:running"] }, labels)).toBe("running");
    expect(agentStateOf({ state: "open", labels: ["bug"] }, labels)).toBe("running");
    expect(agentStateOf({ state: "open", labels: ["swf:question", "swf:running"] }, labels)).toBe("question");
    expect(agentStateOf({ state: "open", labels: ["swf:done"] }, labels)).toBe("done");
    expect(agentStateOf({ state: "open", labels: ["swf:failed"] }, labels)).toBe("failed");
  });

  it("counts a closed or deleted issue as done", () => {
    expect(agentStateOf({ state: "closed", labels: ["swf:running"] }, labels)).toBe("done");
    expect(agentStateOf(null, labels)).toBe("done");
  });
});

describe("issue selection", () => {
  it("counts every VM that is not stopped and the VMs being created", () => {
    const vms = [
      { name: "vm-hunt-s-00000001", status: "RUNNING" },
      { name: "vm-hunt-s-00000002", status: "TERMINATED" },
      { name: "vm-hunt-s-00000003", status: "STOPPED" },
      { name: "vm-hunt-s-00000004", status: "STAGING" },
      { name: "vm-hunt-s-00000005", status: "SUSPENDED" },
    ];
    const active = activeSessionVms(vms, ["vm-hunt-s-00000001", "vm-hunt-s-00000009"]);
    expect([...active].sort()).toEqual(["vm-hunt-s-00000001", "vm-hunt-s-00000004", "vm-hunt-s-00000005", "vm-hunt-s-00000009"]);
  });

  it("starts the oldest issues of the repositories in their configured order and lets the rest wait", () => {
    const issuesByRepo = [
      { repo: "acme/app", issues: [issue(9), issue(3)] },
      { repo: "acme/api", issues: [issue(1)] },
    ];
    const { start, waiting } = issuesToStart(issuesByRepo, 2);
    expect(start.map(({ repo, issue }) => `${repo}#${issue.number}`)).toEqual(["acme/app#3", "acme/app#9"]);
    expect(waiting.map(({ repo, issue }) => `${repo}#${issue.number}`)).toEqual(["acme/api#1"]);
    expect(issuesToStart(issuesByRepo, 0).start).toEqual([]);
    expect(issuesToStart(issuesByRepo, -2).waiting).toHaveLength(3);
    expect(issuesToStart(issuesByRepo, 5).start).toHaveLength(3);
  });
});

describe("issue comments", () => {
  it("claims with the preview URLs, the session, its VM and its branch", () => {
    const names = sessionNames("ab12cd34-0000-4000-8000-000000000001");
    expect(claimComment(names, "feat/general/12-fix-login", "hunt.example.com")).toBe(
      "Hunt started a session for this issue: previews at `https://ab12cd34-<port>.hunt.example.com` once the agent starts the services.\n\n" +
        "Session `ab12cd34-0000-4000-8000-000000000001` on the VM `vm-hunt-s-ab12cd34`, branch `feat/general/12-fix-login`.",
    );
  });

  it("reports a failure in a code block and names the VM that stays", () => {
    expect(failureComment("hunt-ctl: ``` broken", "vm-hunt-s-ab12cd34")).toBe(
      "Hunt could not start a session for this issue:\n\n```\nhunt-ctl: `` broken\n```\n\nThe VM `vm-hunt-s-ab12cd34` stays for inspection.",
    );
    expect(failureComment("quota exceeded", null)).not.toContain("stays");
  });

  it("redacts the known secrets and anything shaped like a GitHub or Claude token", () => {
    const text = "token github_pat_11ABCDEFG0123456789_abcdefghijkl and sk-ant-oat01-abcdefghijklmnopqrstuvwxyz, ghp_abcdefghijklmnopqrstuvwxyz0123 and s3cr3t-value!";
    expect(redact(text, ["s3cr3t-value", "short"])).toBe("token [redacted] and [redacted], [redacted] and [redacted]!");
  });
});

const prompts = {
  remote: readFileSync(new URL("../../../libs/domain/prompts/remote.system-prompt.md", import.meta.url), "utf8"),
  gitPush: readFileSync(new URL("../../../libs/domain/prompts/git-push.system-prompt.md", import.meta.url), "utf8"),
  question: readFileSync(new URL("../../../libs/domain/prompts/question.system-prompt.md", import.meta.url), "utf8"),
  swfSystem: readFileSync(new URL("../prompts/swf.system-prompt.md", import.meta.url), "utf8"),
  swfFirst: readFileSync(new URL("../prompts/swf-first.user-prompt.md", import.meta.url), "utf8"),
  swfNudge: readFileSync(new URL("../prompts/swf-nudge.user-prompt.md", import.meta.url), "utf8"),
};

describe("fillPrompt", () => {
  it("replaces every placeholder and refuses one without a value", () => {
    expect(fillPrompt("Issue #{{number}} of {{repo}}, #{{number}}", { number: "3", repo: "acme/app" })).toBe("Issue #3 of acme/app, #3");
    expect(() => fillPrompt("{{missing}}", {})).toThrow("failed to fill the prompt: no value for {{missing}}");
  });
});

describe("session files", () => {

  it("composes the system prompt like the desktop's remote_system_prompt with an empty base, the swf steps after the shared parts", () => {
    const services = "\n### The repository's services\n- `api`: port 3000\n\n";
    const prompt = remoteSystemPrompt(prompts, "## Working on a GitHub issue\n", services, "\n# Services\nStart api.\n\n");
    const shared = `\n\n${prompts.remote}\n${prompts.gitPush}\n${prompts.question}\n## Working on a GitHub issue\n`;
    const withServices = `${shared}\n### The repository's services\n- \`api\`: port 3000\n`;
    expect(prompt).toBe(`${withServices}\n### The repository's hunt.agent.md\n# Services\nStart api.\n`);
    expect(prompt.startsWith("\n\n## Remote session\n")).toBe(true);
    expect(prompt).toContain("follows at the end when it has one.\n\n### Git\n`origin` is the repository on GitHub.");
    expect(prompt).toContain("## Questions to the user\n\nWhen you end a turn because you need an answer only the user can give");
    expect(remoteSystemPrompt(prompts, "## Working on a GitHub issue\n", services, null)).toBe(withServices);
    expect(remoteSystemPrompt(prompts, "## Working on a GitHub issue\n", "", " \n")).toBe(shared);
    expect(remoteSystemPrompt(prompts, "", null, null)).toBe(remoteSystemPrompt(prompts, "", undefined, undefined));
  });

  it("fills the swf system prompt with the issue, the branch, the labels and the commands that move the issue between them", () => {
    const prompt = swfSystemPrompt(prompts.swfSystem, "acme/app", 12, "feat/general/12-fix-login", swfLabels("swf"));
    expect(prompt.startsWith("## Working on a GitHub issue\n\nHunt's poller started this session for issue #12 of acme/app, which carries the label `swf`;")).toBe(true);
    expect(prompt).toContain("1. **Read the task.**");
    expect(prompt).toContain(
      "gather every open question into one comment on the issue (`gh issue comment 12 --repo acme/app --body \"…\"`) with the options you see and your " +
        "recommendation. Start the comment by mentioning everyone who is to answer, so that GitHub notifies them: every current assignee of the issue " +
        "(`gh issue view 12 --repo acme/app --json assignees -q '.assignees[].login'`) as `@login`, or the issue's author when it has no assignee. " +
        "Then replace `swf:running` with `swf:question` (`gh issue edit 12 --repo acme/app --remove-label swf:running --add-label swf:question`) " +
        "and end your turn with the questions as your last words and the marker `<!-- hunt:question -->`.",
    );
    expect(prompt).toContain("then replace `swf:question` with `swf:running` (`gh issue edit 12 --repo acme/app --remove-label swf:question --add-label swf:running`)");
    expect(prompt).toContain("3. **Plan.** Comment a short implementation plan on the issue");
    expect(prompt).toContain("5. **Pull request.** Commit to the current branch `feat/general/12-fix-login`, push it and open a pull request whose description contains `Closes #12`");
    expect(prompt).toContain(
      "6. **Clean up and finish.** Stop the services you started (`sudo -n hunt-ctl service stop <name>…`) and close the tmux windows you opened, delete the " +
        "scratch files you created outside the repository and leave the working tree clean: `git status` shows nothing uncommitted. Then replace `swf:running` " +
        "with `swf:done`: `gh issue edit 12 --repo acme/app --remove-label swf:running --add-label swf:done`.",
    );
    expect(prompt).toContain("replace `swf:running` with `swf:failed` instead (`gh issue edit 12 --repo acme/app --remove-label swf:running --add-label swf:failed`)");
    expect(prompt.endsWith("a turn that ends with the issue still labelled `swf:running` counts as an unfinished task.\n")).toBe(true);
    expect(prompt).not.toContain("{{");
  });

  it("writes hunt-session.json in the desktop's shape: a new conversation without permission requests", () => {
    expect(JSON.parse(huntSessionFile("ab12cd34-0000-4000-8000-000000000001", "/home/agent/app", "PROMPT"))).toEqual({
      huntSessionId: "ab12cd34-0000-4000-8000-000000000001",
      acpSessionId: null,
      cwd: "/home/agent/app",
      systemPromptAppend: "PROMPT",
      modeId: "bypassPermissions",
      configOptions: {},
    });
  });
});

describe("firstPrompt", () => {
  it("gives the agent the issue with every comment and sends it to the steps of the system prompt", () => {
    const comments = [
      { author: "bob", createdAt: "2026-10-13T09:00:00Z", body: "Also the logout.\n" },
      { author: "carol", createdAt: "2026-10-13T10:30:00Z", body: "Agreed." },
    ];
    const text = firstPrompt(prompts.swfFirst, "acme/app", { ...issue(12, "Fix login"), body: "The login fails." }, comments, "feat/general/12-fix-login", swfLabels("swf"));

    expect(text.startsWith("Work on GitHub issue #12 of acme/app: Fix login\nhttps://github.com/acme/app/issues/12\n")).toBe(true);
    expect(text).toContain("## Issue, opened by @alice on 2026-10-13 08:04 UTC\n\nThe login fails.\n");
    expect(text).toContain("**@bob** on 2026-10-13 09:00 UTC:\n\nAlso the logout.\n\n---\n\n**@carol** on 2026-10-13 10:30 UTC:\n\nAgreed.");
    expect(text.endsWith(
      "Hunt's poller started this session because the issue has the label `swf`. Begin with step 1 of \"Working on a GitHub issue\" in your instructions " +
        "and work through the steps on the branch `feat/general/12-fix-login`.\n",
    )).toBe(true);
    expect(text).not.toContain("{{");
  });

  it("says when the issue has no description or comments", () => {
    const text = firstPrompt(prompts.swfFirst, "acme/app", issue(3), [], "feat/general/3-issue-3", swfLabels("swf"));
    expect(text).toContain("(no description)");
    expect(text).toContain("## Comments\n\n(none)\n");
  });
});

describe("nudgePrompt", () => {
  it("names the three ways out and the consequence of ending the turn again", () => {
    const text = nudgePrompt(prompts.swfNudge, "acme/app", 12, swfLabels("swf"));
    expect(text.startsWith("Your last turn ended, but issue #12 of acme/app still has the label `swf:running`")).toBe(true);
    expect(text).toContain("`Closes #12`");
    expect(text).toContain("(`gh issue edit 12 --repo acme/app --remove-label swf:running --add-label swf:done`)");
    expect(text).toContain("(`gh issue edit 12 --repo acme/app --remove-label swf:running --add-label swf:question`)");
    expect(text).toContain("(`gh issue edit 12 --repo acme/app --remove-label swf:running --add-label swf:failed`)");
    expect(text).toContain("When this turn ends with the issue still labelled running, Hunt marks the issue as failed.");
  });

  it("names the VM in the comment that marks a stopped session as failed", () => {
    expect(stoppedComment("vm-hunt-s-ab12cd34")).toContain("The VM `vm-hunt-s-ab12cd34` keeps the session");
  });
});
