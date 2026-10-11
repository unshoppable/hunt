import { describe, expect, it } from "vitest";
import { isSymbolLikeLabel, roleOfFile, roleOfNames, wordsOf } from "./roles";

describe("wordsOf", () => {
  it("splits camel case, acronyms and separators", () => {
    expect(wordsOf("PaginatedResult")).toEqual(["paginated", "result"]);
    expect(wordsOf("HTTPClient")).toEqual(["http", "client"]);
    expect(wordsOf("user-list.query")).toEqual(["user", "list", "query"]);
  });
});

describe("roleOfFile", () => {
  it("names the role by extension, the last stem word, the hook prefix or the parent directory", () => {
    expect(roleOfFile("apps/backend/src/app/user/user.service.ts")).toBe("business logic");
    expect(roleOfFile("apps/backend/src/app/user/user-list.query.ts")).toBe("query shape");
    expect(roleOfFile("apps/backend/src/app/common/pagination/paginated.result.ts")).toBe("response shape");
    expect(roleOfFile("src/state/useHuntStore.ts")).toBe("hook");
    expect(roleOfFile("src/ipc/types.ts")).toBe("types only");
    expect(roleOfFile("src/components/Popover.tsx")).toBe("UI component");
    expect(roleOfFile("src/app.css")).toBe("styles");
    expect(roleOfFile("src/graph/layout.ts")).toBeNull();
  });
});

describe("roleOfNames", () => {
  it("derives the role from the imported identifiers and never repeats them", () => {
    expect(roleOfNames(["useUsers"], "src/a.ts")).toBe("hook");
    expect(roleOfNames(["NotFoundException"], "src/a.ts")).toBe("error handling");
    expect(roleOfNames(["MAX_PAGE_SIZE", "DEFAULT_SORT"], "src/a.ts")).toBe("constants");
    expect(roleOfNames(["Diagram", "Legend"], "src/a.ts")).toBe("classes & types");
    expect(roleOfNames(["Diagram"], "src/Diagram.tsx")).toBe("UI component");
    expect(roleOfNames(["layoutDiagram", "labelWidth"], "src/a.ts")).toBe("function calls");
    expect(roleOfNames(["Diagram", "layoutDiagram"], "src/a.ts")).toBe("shared code");
    expect(roleOfNames([], "src/a.ts")).toBe("side effects");
  });
});

describe("isSymbolLikeLabel", () => {
  it("flags identifiers and file names, not purposes", () => {
    expect(isSymbolLikeLabel("PaginatedResult", "a.ts", "b.ts")).toBe(true);
    expect(isSymbolLikeLabel("useUsers", "a.ts", "b.ts")).toBe(true);
    expect(isSymbolLikeLabel("MAX_PAGE_SIZE", "a.ts", "b.ts")).toBe(true);
    expect(isSymbolLikeLabel("user.service.ts", "a.ts", "b.ts")).toBe(true);
    expect(isSymbolLikeLabel("user.service", "a.ts", "user/user.service.ts")).toBe(true);
    expect(isSymbolLikeLabel("UserService", "a.ts", "user/user.service.ts")).toBe(true);
    expect(isSymbolLikeLabel("Antwortformat", "a.ts", "b.ts")).toBe(false);
    expect(isSymbolLikeLabel("ORM-Lebenszyklus", "a.ts", "b.ts")).toBe(false);
    expect(isSymbolLikeLabel("Paginierung erben", "a.ts", "b.ts")).toBe(false);
    expect(isSymbolLikeLabel("GraphQL", "a.ts", "b.ts")).toBe(false);
    expect(isSymbolLikeLabel("hook", "a.ts", "src/hook.ts")).toBe(false);
  });
});
