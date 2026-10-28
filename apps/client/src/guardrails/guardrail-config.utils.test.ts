import { describe, expect, it } from "vitest";
import {
  adrDirOf,
  DEFAULT_GUARDRAIL_DIRS,
  DEFAULT_GUARDRAIL_SKILL,
  guardrailSkillOf,
  normalizeGuardrailDir,
  proposedSwfSkill,
  swfSkillsOf,
} from "./guardrail-config.utils";

describe("normalizeGuardrailDir", () => {
  it("strips surrounding whitespace, leading ./ and trailing slashes", () => {
    expect(normalizeGuardrailDir("  ./docs/adr/ ")).toBe("docs/adr");
    expect(normalizeGuardrailDir("docs//decisions")).toBe("docs/decisions");
    expect(normalizeGuardrailDir(".claude\\rules")).toBe(".claude/rules");
  });

  it("rejects empty, absolute and parent-escaping paths", () => {
    expect(normalizeGuardrailDir("   ")).toBeNull();
    expect(normalizeGuardrailDir("./")).toBeNull();
    expect(normalizeGuardrailDir("/etc")).toBeNull();
    expect(normalizeGuardrailDir("../other/docs")).toBeNull();
  });
});

describe("adrDirOf", () => {
  it("reads the ADR folder hunt.json sets as adrDir", () => {
    expect(adrDirOf('{ "version": 3, "adrDir": "./docs/adr/" }')).toBe("docs/adr");
  });

  it("falls back to the default without the file, the field or a usable value", () => {
    for (const huntJson of ["", "{", "null", '{ "version": 3 }', '{ "adrDir": 7 }', '{ "adrDir": "../elsewhere" }', '{ "adrDir": "/etc" }']) {
      expect(adrDirOf(huntJson)).toBe(DEFAULT_GUARDRAIL_DIRS.adr);
    }
  });
});

describe("guardrailSkillOf", () => {
  it("reads the skill hunt.json sets as guardrailSkill", () => {
    expect(guardrailSkillOf('{ "version": 3, "guardrailSkill": "team-lessons" }')).toBe("team-lessons");
  });

  it("falls back to the default without the file, the field or a usable value", () => {
    for (const huntJson of ["", "{", "null", '{ "version": 3 }', '{ "guardrailSkill": 7 }', '{ "guardrailSkill": "Team Lessons" }', '{ "guardrailSkill": "-a" }', `{ "guardrailSkill": "${"a".repeat(65)}" }`]) {
      expect(guardrailSkillOf(huntJson)).toBe(DEFAULT_GUARDRAIL_SKILL);
    }
  });
});

describe("proposedSwfSkill", () => {
  it("is the name of Hunt's template for the step", () => {
    expect(proposedSwfSkill("plan")).toBe("swf-plan");
    expect(proposedSwfSkill("pr")).toBe("swf-pr");
  });
});

describe("swfSkillsOf", () => {
  it("lists every agent step without a name for an swf section without skills", () => {
    expect(swfSkillsOf('{ "version": 3, "swf": {} }')).toEqual([
      { step: "plan", name: null },
      { step: "implement", name: null },
      { step: "verify", name: null },
      { step: "gate", name: null },
      { step: "pr", name: null },
    ]);
  });

  it("takes the usable names of swf.skills and leaves the other steps without a name", () => {
    const entries = swfSkillsOf('{ "swf": { "skills": { "plan": "team-plan", "verify": "Bad Name", "gate": 7, "pr": "swf-pr" } } }');
    expect(entries?.map((entry) => entry.name)).toEqual(["team-plan", null, null, null, "swf-pr"]);
  });

  it("is null without the file or an swf section", () => {
    for (const huntJson of ["", "{", "null", '{ "version": 3 }', '{ "swf": null }', '{ "swf": [] }', '{ "swf": "yes" }']) {
      expect(swfSkillsOf(huntJson)).toBeNull();
    }
  });
});
