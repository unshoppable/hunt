import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Issue } from "./github.ts";
import {
  activeSessionVms,
  branchName,
  claimComment,
  failureComment,
  firstPrompt,
  huntSessionFile,
  issuesToStart,
  redact,
  remoteSystemPrompt,
  sessionNames,
  slugify,
  swfLabels,
} from "./swfPlan.ts";

function issue(number: number, title = `Issue ${number}`, labels = ["swf"]): Issue {
  return { number, title, body: "", author: "alice", createdAt: "2026-10-13T08:04:05Z", url: `https://github.com/acme/app/issues/${number}`, labels };
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
    expect(swfLabels("swf")).toEqual({ requested: "swf", running: "swf:running", done: "swf:done", failed: "swf:failed" });
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
  it("claims with the preview URL, the session, its VM and its branch", () => {
    const names = sessionNames("ab12cd34-0000-4000-8000-000000000001");
    expect(claimComment(names, "feat/general/12-fix-login", "hunt.example.com")).toBe(
      "Hunt started a session for this issue: preview `https://ab12cd34.hunt.example.com` (available once the agent starts the app).\n\n" +
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

describe("session files", () => {
  const prompts = {
    remote: readFileSync(new URL("../../../libs/domain/prompts/remote.md", import.meta.url), "utf8"),
    gitPush: readFileSync(new URL("../../../libs/domain/prompts/git-push.md", import.meta.url), "utf8"),
  };

  it("composes the system prompt like the desktop's remote_system_prompt with an empty base", () => {
    const prompt = remoteSystemPrompt(prompts, "\n# Preview\nStart the UIs.\n\n");
    expect(prompt).toBe(`\n\n${prompts.remote}\n${prompts.gitPush}\n### The repository's HUNT.md\n# Preview\nStart the UIs.\n`);
    expect(prompt.startsWith("\n\n## Remote session\n")).toBe(true);
    expect(prompt).toContain("follows at the end when it has one.\n\n### Git\n`origin` is the repository on GitHub.");
    expect(remoteSystemPrompt(prompts, " \n")).toBe(`\n\n${prompts.remote}\n${prompts.gitPush}`);
    expect(remoteSystemPrompt(prompts, null)).toBe(remoteSystemPrompt(prompts, undefined));
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
  it("gives the agent the issue with every comment and the steps up to the label", () => {
    const comments = [
      { author: "bob", createdAt: "2026-10-13T09:00:00Z", body: "Also the logout.\n" },
      { author: "carol", createdAt: "2026-10-13T10:30:00Z", body: "Agreed." },
    ];
    const text = firstPrompt("acme/app", { ...issue(12, "Fix login"), body: "The login fails." }, comments, "feat/general/12-fix-login", swfLabels("swf"));

    expect(text.startsWith("Work on GitHub issue #12 of acme/app: Fix login\nhttps://github.com/acme/app/issues/12\n")).toBe(true);
    expect(text).toContain("## Issue, opened by @alice on 2026-10-13 08:04 UTC\n\nThe login fails.\n");
    expect(text).toContain("**@bob** on 2026-10-13 09:00 UTC:\n\nAlso the logout.\n\n---\n\n**@carol** on 2026-10-13 10:30 UTC:\n\nAgreed.");
    expect(text).toContain("Commit to the current branch `feat/general/12-fix-login`, push it and open a pull request whose description contains `Closes #12`.");
    expect(text).toContain("`gh issue comment 12 --repo acme/app --body");
    expect(text).toContain("`gh issue edit 12 --repo acme/app --remove-label swf:running --add-label swf:done`");
    expect(text).toContain("replace `swf:running` with `swf:failed` instead (`gh issue edit 12 --repo acme/app --remove-label swf:running --add-label swf:failed`)");
  });

  it("says when the issue has no description or comments", () => {
    const text = firstPrompt("acme/app", issue(3), [], "feat/general/3-issue-3", swfLabels("swf"));
    expect(text).toContain("(no description)");
    expect(text).toContain("## Comments\n\n(none)\n");
  });
});
