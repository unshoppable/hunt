import { describe, expect, it } from "vitest";
import { identifiersOf, matchesWord, searchDiagramFiles } from "./graph-search.utils";

describe("identifiersOf", () => {
  it("collects the distinct identifiers of a source", () => {
    const source = `import { trackJob } from "./jobs";\nexport const syncJobId = trackJob($queue, x);`;
    expect([...identifiersOf(source)].sort()).toEqual(["$queue", "const", "export", "from", "import", "jobs", "syncJobId", "trackJob"]);
  });
});

describe("matchesWord", () => {
  it("matches a substring ignoring case", () => {
    expect(matchesWord("WorkingTimeSyncService", "timesync")).toBe(true);
  });

  it("matches camel humps and separators", () => {
    expect(matchesWord("workingTimeSyncService", "wtss")).toBe(true);
    expect(matchesWord("workingTimeSyncService", "worktimesync")).toBe(true);
    expect(matchesWord("apps/backend/employee-import.service.ts", "emp-imp")).toBe(true);
    expect(matchesWord("apps/backend/employee-import.service.ts", "empimpserv")).toBe(true);
  });

  it("rejects characters scattered inside words", () => {
    expect(matchesWord("workingTimeSyncService", "wkg")).toBe(false);
    expect(matchesWord("employee", "eye")).toBe(false);
  });

  it("backtracks when the first word start does not lead to a match", () => {
    expect(matchesWord("syncJobSyncReport", "sr")).toBe(true);
  });
});

describe("searchDiagramFiles", () => {
  const PATHS = ["apps/backend/employee-import.service.ts", "apps/backend/working-time-sync.service.ts", "libs/shared/job-outcome.types.ts"];
  const IDENTIFIERS = new Map([
    ["apps/backend/employee-import.service.ts", new Set(["loadEmployeeProfileSnapshot", "enqueueSync"])],
    ["libs/shared/job-outcome.types.ts", new Set(["UsJobOutcomeStatus"])],
  ]);

  it("is null for an empty query", () => {
    expect(searchDiagramFiles(PATHS, IDENTIFIERS, "  ")).toBeNull();
  });

  it("keeps only the files whose name matches while there are any", () => {
    expect(searchDiagramFiles(PATHS, IDENTIFIERS, "sync")).toEqual(new Map([["apps/backend/working-time-sync.service.ts", "name"]]));
  });

  it("falls back to paths and the identifiers of the content", () => {
    expect(searchDiagramFiles(PATHS, IDENTIFIERS, "backend")).toEqual(
      new Map([
        ["apps/backend/employee-import.service.ts", "path"],
        ["apps/backend/working-time-sync.service.ts", "path"],
      ]),
    );
    expect(searchDiagramFiles(PATHS, IDENTIFIERS, "enqueue")).toEqual(new Map([["apps/backend/employee-import.service.ts", "symbol"]]));
    expect(searchDiagramFiles(PATHS, IDENTIFIERS, "jobOutStat")).toEqual(new Map([["libs/shared/job-outcome.types.ts", "symbol"]]));
  });

  it("needs every word to match the path or an identifier", () => {
    expect(searchDiagramFiles(PATHS, IDENTIFIERS, "backend enqueue")).toEqual(new Map([["apps/backend/employee-import.service.ts", "symbol"]]));
    expect(searchDiagramFiles(PATHS, IDENTIFIERS, "working enqueue")).toEqual(new Map());
  });
});
