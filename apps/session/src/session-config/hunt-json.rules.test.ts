import { describe, expect, it } from "vitest";
import type * as z from "zod/mini";
import {
  GLOB_PATTERN_RULE,
  ZodCommandLine,
  ZodContractVersion,
  ZodEnvValue,
  ZodEnvVariableName,
  ZodFlag,
  ZodGlobPattern,
  ZodGlobPatterns,
  ZodModelId,
  ZodNoContract2Placeholders,
  ZodRemoteSecretReference,
  ZodServiceName,
  ZodServicePlaceholder,
  ZodServicePort,
  ZodSkillName,
  ZodWorktreeFile,
  ZodWorktreeFolder,
} from "./hunt-json.rules.ts";

const FOLDER_RULE =
  'must be a folder relative to the worktree such as "apps/web": at most 255 characters, segments of letters, digits, ".", "_" and "-", none . or ..';
const FILE_RULE =
  'must be a file relative to the worktree such as ".claude/declined-guardrails.jsonl": at most 255 characters, segments of letters, digits, ".", "_" and "-", none . or ..';
const PORT_RULE = "must be an integer from 1024 to 65535";

/** The issues of `value` under `schema` as `<path>: <message>`, the path empty for the value itself. */
function issuesOf(schema: z.ZodMiniType, value: unknown): string[] {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

describe("hunt.json rules", () => {
  it("require contract version 3", () => {
    expect(issuesOf(ZodContractVersion, 3)).toEqual([]);
    for (const version of [2, "3", undefined]) {
      expect(issuesOf(ZodContractVersion, version)).toEqual([": must be 3"]);
    }
  });

  it("name services and checks in lowercase kebab-case of at most 32 characters", () => {
    for (const name of ["web", "w-2", "a".repeat(32)]) {
      expect(issuesOf(ZodServiceName, name)).toEqual([]);
    }
    for (const name of ["Web", "1web", "web_ui", "-web", "a".repeat(33), 1]) {
      expect(issuesOf(ZodServiceName, name)).toEqual([": invalid name, must match ^[a-z][a-z0-9-]{0,31}$"]);
    }
  });

  it("report a line break and the length of a command line together, but nothing more of an empty one", () => {
    expect(ZodCommandLine.parse("x".repeat(4096))).toHaveLength(4096);
    for (const command of ["", "  ", ["npm"], undefined]) {
      expect(issuesOf(ZodCommandLine, command)).toEqual([": must be a non-empty string"]);
    }
    expect(issuesOf(ZodCommandLine, "npm\rstart")).toEqual([": must be a single line"]);
    expect(issuesOf(ZodCommandLine, `a\n${"x".repeat(4096)}`)).toEqual([": must be a single line", ": must be at most 4096 characters long"]);
  });

  it("take folders relative to the worktree without . and .. segments", () => {
    for (const folder of ["apps/ui", ".config/a.b_c-D9", `${"a".repeat(127)}/${"b".repeat(127)}`]) {
      expect(issuesOf(ZodWorktreeFolder, folder)).toEqual([]);
    }
    for (const folder of ["/srv/app", "../app", "a/./b", "a/", "a b", "", "x".repeat(256), 1]) {
      expect(issuesOf(ZodWorktreeFolder, folder)).toEqual([`: ${FOLDER_RULE}`]);
    }
  });

  it("take files relative to the worktree by the rules of folders", () => {
    expect(issuesOf(ZodWorktreeFile, ".claude/resources/guardrails/declined-guardrails.jsonl")).toEqual([]);
    for (const file of ["/srv/declines.jsonl", "../declines.jsonl", "a/./b.jsonl", "", 1]) {
      expect(issuesOf(ZodWorktreeFile, file)).toEqual([`: ${FILE_RULE}`]);
    }
  });

  it("take the ports from 1024 to 65535 that no part of the session VM holds", () => {
    for (const port of [1024, 3000, 65535]) {
      expect(issuesOf(ZodServicePort, port)).toEqual([]);
    }
    for (const port of [1023, 65536, 3000.5, "3000", Number.NaN, undefined]) {
      expect(issuesOf(ZodServicePort, port)).toEqual([`: ${PORT_RULE}`]);
    }
    expect(issuesOf(ZodServicePort, 9232)).toEqual([": 9232 is reserved for the review server of the preview proxy"]);
  });

  it("take booleans as flags", () => {
    expect(issuesOf(ZodFlag, false)).toEqual([]);
    expect(issuesOf(ZodFlag, "true")).toEqual([": must be true or false"]);
  });

  it("name variables in upper case outside Hunt's prefixes and keep their values to one line", () => {
    expect(issuesOf(ZodEnvVariableName, "_A1")).toEqual([]);
    expect(issuesOf(ZodEnvVariableName, "hunt_x")).toEqual([": invalid name, must match ^[A-Z_][A-Z0-9_]*$"]);
    expect(issuesOf(ZodEnvVariableName, "CLAUDE_X")).toEqual([": reserved: names starting with CLAUDE_ or HUNT_ belong to Hunt"]);
    expect(issuesOf(ZodEnvValue, "")).toEqual([]);
    expect(issuesOf(ZodEnvValue, null)).toEqual([": must be a string"]);
    expect(issuesOf(ZodEnvValue, "a\0b")).toEqual([": must be a single line"]);
  });

  it("report every placeholder of contract 2 and read the service of a publicUrl placeholder", () => {
    expect(issuesOf(ZodNoContract2Placeholders, "${HOME}/${services.ui.publicUrl}")).toEqual([]);
    expect(issuesOf(ZodNoContract2Placeholders, "${HUNT_A}/${HUNT_B}")).toEqual([
      ": ${HUNT_A} is a placeholder of contract 2, use ${services.<name>.publicUrl}",
      ": ${HUNT_B} is a placeholder of contract 2, use ${services.<name>.publicUrl}",
    ]);
    expect(ZodServicePlaceholder.parse("${services.ui.publicUrl}")).toBe("ui");
    for (const placeholder of ["${services.ui.url}", "${services..publicUrl}", "${services.ui.publicUrl.host}"]) {
      expect(issuesOf(ZodServicePlaceholder, placeholder)).toEqual([`: unknown placeholder ${placeholder}, the form is \${services.<name>.publicUrl}`]);
    }
  });

  it("read the name of a remote secret from its reference", () => {
    expect(ZodRemoteSecretReference.parse("$MED_OPENAI_API_KEY")).toBe("MED_OPENAI_API_KEY");
    for (const reference of ["MED_KEY", "${MED_KEY}", "$med_key", "$", `$A${"B".repeat(64)}`, 1]) {
      expect(issuesOf(ZodRemoteSecretReference, reference)).toEqual([': must be "$<NAME>", the name of a remote secret matching ^[A-Z][A-Z0-9_]{0,63}$']);
    }
  });

  it("take at most 64 glob patterns and report each unusable one at its index", () => {
    expect(issuesOf(ZodGlobPattern, "x".repeat(255))).toEqual([]);
    expect(ZodGlobPatterns.parse(["**/.env.private", "config/*.local"])).toEqual(["**/.env.private", "config/*.local"]);
    for (const patterns of ["**/.env", Array.from({ length: 65 }, () => "")]) {
      expect(issuesOf(ZodGlobPatterns, patterns)).toEqual([": must be a list of at most 64 glob patterns"]);
    }
    expect(issuesOf(ZodGlobPatterns, ["a", "", "/etc/hosts", "a/../b", "a\nb", 1])).toEqual([1, 2, 3, 4, 5].map((index) => `${index}: ${GLOB_PATTERN_RULE}`));
  });

  it("take the full IDs of Claude models and the kebab-case names of skills", () => {
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5[1m]", `claude-${"x".repeat(121)}`]) {
      expect(issuesOf(ZodModelId, model)).toEqual([]);
    }
    expect(issuesOf(ZodModelId, "opus")).toEqual([': must be the full ID of a Claude model such as "claude-opus-5-5", at most 128 characters, not an alias such as "opus"']);
    expect(issuesOf(ZodSkillName, "a".repeat(64))).toEqual([]);
    expect(issuesOf(ZodSkillName, "a--b")).toEqual([': must be the kebab-case name of a skill such as "guardrail": letters, digits and "-", at most 64 characters']);
  });
});
