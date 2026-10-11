import { describe, expect, it } from "vitest";
import { CODE_FONT_FAMILY, DEFAULT_GUARDRAIL_DIRS, DEFAULT_PANES, SETTINGS_VERSION, mergeSettings, migrateSettings, normalizeGuardrailDir } from "./settings";

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

describe("migrateSettings", () => {
  it("moves the version 0 font sizes into the panes and fills the rest from the defaults", () => {
    const migrated = migrateSettings({ diffFontSize: 13, uiFontSize: 15, changelistView: "flat" }, 0);
    expect(migrated.panes?.diff).toEqual({ ...DEFAULT_PANES.diff, fontSize: 13 });
    expect(migrated.panes?.sidebar).toEqual({ ...DEFAULT_PANES.sidebar, fontSize: 15 });
    expect(migrated.panes?.chat).toEqual(DEFAULT_PANES.chat);
    expect(migrated.changelistView).toBe("flat");
  });

  it("keeps unknown keys and lifts the old defaults of versions 1 to 4", () => {
    const stored = { panes: { diff: { background: "#272c35", fontFamily: '"Code Monospace", ui-monospace, SFMono-Regular, Menlo, Monaco, "JetBrains Mono", monospace' }, changelist: { lineHeight: 1.5 } }, later: true };
    const migrated = migrateSettings(stored, 1) as typeof stored & { later: boolean };
    expect(migrated.later).toBe(true);
    expect(migrated.panes?.diff).toEqual({ background: DEFAULT_PANES.diff.background, fontFamily: CODE_FONT_FAMILY });
    expect(migrated.panes?.changelist).toEqual({ lineHeight: DEFAULT_PANES.changelist.lineHeight });
  });

  it("leaves a user's own values of versions 1 to 4 alone", () => {
    const migrated = migrateSettings({ panes: { diff: { background: "#000000", fontFamily: "Menlo" } } }, 3);
    expect(migrated.panes?.diff).toEqual({ background: "#000000", fontFamily: "Menlo" });
  });

  it("passes the current version through untouched", () => {
    const stored = { panes: { chat: { fontSize: 18 } }, aiLanguage: "English", later: true };
    expect(migrateSettings(stored, SETTINGS_VERSION)).toBe(stored);
  });
});

describe("mergeSettings", () => {
  const current = { panes: DEFAULT_PANES, guardrailDirs: DEFAULT_GUARDRAIL_DIRS, aiLanguage: "German", showSummary: true, confirmSessionDelete: true };

  it("layers the persisted state over the defaults", () => {
    const merged = mergeSettings({ aiLanguage: "English", panes: { chat: { fontSize: 18 } } }, current);
    expect(merged.aiLanguage).toBe("English");
    expect(merged.showSummary).toBe(true);
    expect(merged.confirmSessionDelete).toBe(true);
    expect(merged.panes.chat).toEqual({ ...DEFAULT_PANES.chat, fontSize: 18 });
  });

  it("fills a missing pane and a missing guardrail folder from the defaults", () => {
    const merged = mergeSettings({ panes: { chat: { fontSize: 18 } }, guardrailDirs: { adr: "decisions" } }, current);
    expect(merged.panes.sidebar).toEqual(DEFAULT_PANES.sidebar);
    expect(merged.panes.diff).toEqual(DEFAULT_PANES.diff);
    expect(merged.guardrailDirs).toEqual({ ...DEFAULT_GUARDRAIL_DIRS, adr: "decisions" });
  });

  it("returns the defaults when nothing is persisted", () => {
    const merged = mergeSettings(undefined, current);
    expect(merged.panes).toEqual(DEFAULT_PANES);
    expect(merged.guardrailDirs).toEqual(DEFAULT_GUARDRAIL_DIRS);
  });
});
