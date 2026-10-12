import { describe, expect, it } from "vitest";
import {
  CODE_FONT_FAMILY,
  DEFAULT_GRAPH_AGENT,
  DEFAULT_GUARDRAIL_DIRS,
  DEFAULT_PANES,
  DEFAULT_POPUP_SIZES,
  DEFAULT_REMOTE,
  SETTINGS_VERSION,
  configuredVm,
  mergeSettings,
  migrateSettings,
  normalizeGuardrailDir,
  normalizeRemote,
} from "./settings";

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
    const stored = { panes: { diff: { background: "#272c35", fontFamily: '"Code Monospace", ui-monospace, SFMono-Regular, Menlo, Monaco, "JetBrains Mono", monospace' }, changelist: { lineHeight: 1.5 }, chat: { lineHeight: 1.7 } }, later: true };
    const migrated = migrateSettings(stored, 1) as typeof stored & { later: boolean };
    expect(migrated.later).toBe(true);
    expect(migrated.panes?.diff).toEqual({ background: DEFAULT_PANES.diff.background, fontFamily: CODE_FONT_FAMILY });
    expect(migrated.panes?.changelist).toEqual({ lineHeight: DEFAULT_PANES.changelist.lineHeight });
    expect(migrated.panes?.chat).toEqual({ lineHeight: DEFAULT_PANES.chat.lineHeight });
  });

  it("lifts the old chat line height of versions 5 to 7 and leaves a user's own value alone", () => {
    const lifted = migrateSettings({ panes: { chat: { lineHeight: 1.7 } }, usagesPopupSize: { width: 900, height: 500 } }, 6);
    expect(lifted.panes?.chat).toEqual({ lineHeight: DEFAULT_PANES.chat.lineHeight });
    expect(lifted.popupSizes).toEqual({ usages: { width: 900, height: 500 } });
    const kept = migrateSettings({ panes: { chat: { lineHeight: 1.6 } } }, 7);
    expect(kept.panes?.chat).toEqual({ lineHeight: 1.6 });
  });

  it("leaves a user's own values of versions 1 to 4 alone", () => {
    const migrated = migrateSettings({ panes: { diff: { background: "#000000", fontFamily: "Menlo" } } }, 3);
    expect(migrated.panes?.diff).toEqual({ background: "#000000", fontFamily: "Menlo" });
  });

  it("gathers the popup sizes of versions 5 and 6 into one map", () => {
    const migrated = migrateSettings({ usagesPopupSize: { width: 900, height: 500 }, subChatPopoverSize: { width: 700, height: 800 }, aiLanguage: "English" }, 6);
    expect(migrated.popupSizes).toEqual({ usages: { width: 900, height: 500 }, subChat: { width: 700, height: 800 } });
    expect(migrated.aiLanguage).toBe("English");
    expect(migrated).not.toHaveProperty("usagesPopupSize");
  });

  it("points icon rules of version 8 that name a Catppuccin icon at its Atom Material counterpart", () => {
    const stored = { iconRules: [{ glob: "*.service.ts", icon: "nest-service" }, { glob: "*.spec.ts", icon: "typescript-test" }, { glob: "*.dto.ts", icon: "dto" }] };
    expect(migrateSettings(stored, 8).iconRules).toEqual([
      { glob: "*.service.ts", icon: "nestservice" },
      { glob: "*.spec.ts", icon: "testtsfiles" },
      { glob: "*.dto.ts", icon: "dto" },
    ]);
  });

  it("passes the current version through untouched", () => {
    const stored = { panes: { chat: { fontSize: 18 } }, aiLanguage: "English", later: true };
    expect(migrateSettings(stored, SETTINGS_VERSION)).toBe(stored);
  });
});

describe("mergeSettings", () => {
  const current = {
    panes: DEFAULT_PANES,
    graphAgent: DEFAULT_GRAPH_AGENT,
    guardrailDirs: DEFAULT_GUARDRAIL_DIRS,
    popupSizes: DEFAULT_POPUP_SIZES,
    remote: DEFAULT_REMOTE,
    aiLanguage: "German",
    showSummary: true,
    confirmSessionDelete: true,
  };

  it("layers the persisted state over the defaults", () => {
    const merged = mergeSettings({ aiLanguage: "English", panes: { chat: { fontSize: 18 } } }, current);
    expect(merged.aiLanguage).toBe("English");
    expect(merged.showSummary).toBe(true);
    expect(merged.confirmSessionDelete).toBe(true);
    expect(merged.panes.chat).toEqual({ ...DEFAULT_PANES.chat, fontSize: 18 });
  });

  it("fills a missing pane, guardrail folder, popup size and diagram agent value from the defaults", () => {
    const persisted = {
      panes: { chat: { fontSize: 18 } },
      graphAgent: { model: "fable" },
      guardrailDirs: { adr: "decisions" },
      popupSizes: { usages: { width: 900, height: 500 } },
    };
    const merged = mergeSettings(persisted, current);
    expect(merged.graphAgent).toEqual({ ...DEFAULT_GRAPH_AGENT, model: "fable" });
    expect(merged.panes.sidebar).toEqual(DEFAULT_PANES.sidebar);
    expect(merged.panes.diff).toEqual(DEFAULT_PANES.diff);
    expect(merged.guardrailDirs).toEqual({ ...DEFAULT_GUARDRAIL_DIRS, adr: "decisions" });
    expect(merged.popupSizes).toEqual({ ...DEFAULT_POPUP_SIZES, usages: { width: 900, height: 500 } });
  });

  it("keeps the default file patterns when only the VM was stored", () => {
    const merged = mergeSettings({ remote: { project: "p", zone: "z", instance: "vm" } }, current);
    expect(merged.remote).toEqual({ project: "p", zone: "z", instance: "vm", filePatterns: DEFAULT_REMOTE.filePatterns });
  });

  it("returns the defaults when nothing is persisted", () => {
    const merged = mergeSettings(undefined, current);
    expect(merged.panes).toEqual(DEFAULT_PANES);
    expect(merged.graphAgent).toEqual(DEFAULT_GRAPH_AGENT);
    expect(merged.guardrailDirs).toEqual(DEFAULT_GUARDRAIL_DIRS);
    expect(merged.popupSizes).toEqual(DEFAULT_POPUP_SIZES);
  });
});

describe("remote settings", () => {
  it("offers a VM only once project, zone and instance are set", () => {
    expect(configuredVm(DEFAULT_REMOTE)).toBeNull();
    expect(configuredVm({ ...DEFAULT_REMOTE, project: "p", zone: "z" })).toBeNull();
    expect(configuredVm({ ...DEFAULT_REMOTE, project: " p ", zone: "z", instance: "vm" })).toEqual({ project: "p", zone: "z", instance: "vm" });
  });

  it("drops blank, absolute and worktree-leaving file patterns", () => {
    const remote = normalizeRemote({ ...DEFAULT_REMOTE, filePatterns: [" **/.env.private ", "", "/etc/hosts", "../secret", "config/*.local"] });
    expect(remote.filePatterns).toEqual(["**/.env.private", "config/*.local"]);
  });
});
