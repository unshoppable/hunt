import { beforeEach, describe, expect, it } from "vitest";
import { RECENT_REPO_LIMIT, useAgentDefaultsStore, withRecentRepoPath } from "./agent-defaults.store";

describe("withRecentRepoPath", () => {
  it("puts the repository first and drops its earlier entry", () => {
    expect(withRecentRepoPath(["/a", "/b", "/c"], "/b")).toEqual(["/b", "/a", "/c"]);
  });

  it("keeps the list at the limit", () => {
    const paths = Array.from({ length: RECENT_REPO_LIMIT }, (_, index) => `/repo-${index}`);
    const result = withRecentRepoPath(paths, "/new");
    expect(result).toHaveLength(RECENT_REPO_LIMIT);
    expect(result[0]).toBe("/new");
    expect(result).not.toContain(`/repo-${RECENT_REPO_LIMIT - 1}`);
  });
});

describe("pickConfig", () => {
  beforeEach(() => {
    useAgentDefaultsStore.setState({ preferred: {}, effortByModel: {} });
  });

  it("remembers an effort together with the model it was picked with", () => {
    const changes = useAgentDefaultsStore.getState().pickConfig("effort", "high", "opus");
    expect(changes).toEqual([["effort", "high"]]);
    expect(useAgentDefaultsStore.getState().preferred).toEqual({ model: "opus", effort: "high" });
    expect(useAgentDefaultsStore.getState().effortByModel).toEqual({ opus: "high" });
  });

  it("brings back the effort picked last with a model", () => {
    const { pickConfig } = useAgentDefaultsStore.getState();
    pickConfig("effort", "max", "opus");
    pickConfig("effort", "low", "fable");
    expect(pickConfig("model", "opus", "fable")).toEqual([["model", "opus"], ["effort", "max"]]);
    expect(useAgentDefaultsStore.getState().preferred).toEqual({ model: "opus", effort: "max" });
  });

  it("leaves the effort alone for a model picked without one", () => {
    const { pickConfig } = useAgentDefaultsStore.getState();
    pickConfig("effort", "low", "fable");
    expect(pickConfig("model", "opus", "fable")).toEqual([["model", "opus"]]);
    expect(useAgentDefaultsStore.getState().preferred).toEqual({ model: "opus", effort: "low" });
  });
});
