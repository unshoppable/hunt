import { describe, expect, it } from "vitest";
import { extendSelection, singleSelection, toggleInSelection, visibleSelection } from "./treeSelection";

const rowKeys = ["", "angular-component", "angular-di", "angular-directives", "angular-forms", "angular-http"];

describe("extendSelection", () => {
  it("selects every visible row between the anchor and the clicked row, in both directions", () => {
    expect(extendSelection(singleSelection("angular-component"), rowKeys, "angular-forms")).toEqual({
      lead: "angular-forms",
      anchor: "angular-component",
      keys: ["angular-component", "angular-di", "angular-directives", "angular-forms"],
    });
    expect(extendSelection(singleSelection("angular-forms"), rowKeys, "angular-di").keys).toEqual(["angular-di", "angular-directives", "angular-forms"]);
  });

  it("keeps the anchor, so a second ⇧-click replaces the range", () => {
    const first = extendSelection(singleSelection("angular-di"), rowKeys, "angular-http");
    expect(extendSelection(first, rowKeys, "angular-component").keys).toEqual(["angular-component", "angular-di"]);
  });

  it("selects only the clicked row without a selection or with a hidden anchor", () => {
    expect(extendSelection(null, rowKeys, "angular-di")).toEqual(singleSelection("angular-di"));
    expect(extendSelection(singleSelection("angular-di/SKILL.md"), rowKeys, "angular-forms")).toEqual(singleSelection("angular-forms"));
  });
});

describe("toggleInSelection", () => {
  it("adds and removes a row and makes it the anchor of the next range", () => {
    const added = toggleInSelection(singleSelection("angular-component"), "angular-forms");
    expect(added).toEqual({ lead: "angular-forms", anchor: "angular-forms", keys: ["angular-component", "angular-forms"] });
    expect(toggleInSelection(added, "angular-component")).toEqual({ lead: "angular-component", anchor: "angular-component", keys: ["angular-forms"] });
    expect(extendSelection(added, rowKeys, "angular-http").keys).toEqual(["angular-forms", "angular-http"]);
  });
});

describe("visibleSelection", () => {
  it("drops hidden rows and follows the display order", () => {
    const selection = { lead: "angular-di", anchor: "angular-di", keys: ["angular-http", "angular-di/SKILL.md", "angular-di"] };
    expect(visibleSelection(selection, rowKeys)).toEqual(["angular-di", "angular-http"]);
    expect(visibleSelection(null, rowKeys)).toEqual([]);
  });
});
