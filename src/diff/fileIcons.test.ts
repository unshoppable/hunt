import { describe, expect, it } from "vitest";
import associations from "./catppuccinIcons/associations.json";
import { DEFAULT_ICON_RULES, type IconRule } from "../state/settings";
import { fileIconUrl, folderIconUrl, iconUrl, resolveFileIcon, rootFolderIconUrl } from "./fileIcons";

const shipped = new Set(Object.keys(import.meta.glob("./catppuccinIcons/icons/*.svg")).map((path) => path.slice(path.lastIndexOf("/") + 1, -".svg".length)));

describe("vendored Catppuccin icon set", () => {
  it("ships an SVG for every association, every open folder state and the fallbacks", () => {
    expect(Object.values(associations.fileNames).filter((icon) => !shipped.has(icon))).toEqual([]);
    expect(Object.values(associations.fileExtensions).filter((icon) => !shipped.has(icon))).toEqual([]);
    expect(Object.values(associations.folderNames).filter((icon) => !shipped.has(icon) || !shipped.has(`${icon}_open`))).toEqual([]);
    for (const icon of ["_file", "_folder", "_folder_open", "_root", "_root_open"]) {
      expect(shipped.has(icon)).toBe(true);
    }
  });

  it("ships every icon the default rules name", () => {
    expect(DEFAULT_ICON_RULES.map((rule) => rule.icon).filter((icon) => !shipped.has(icon))).toEqual([]);
  });
});

describe("resolveFileIcon", () => {
  it("gives backend building blocks NestJS icons and frontend ones Angular icons by default", () => {
    expect(resolveFileIcon("apps/backend/src/user/user.service.ts", DEFAULT_ICON_RULES)).toBe("nest-service");
    expect(resolveFileIcon("apps/api/src/auth/auth.guard.ts", DEFAULT_ICON_RULES)).toBe("nest-guard");
    expect(resolveFileIcon("apps/api/src/app.module.ts", DEFAULT_ICON_RULES)).toBe("nest");
    expect(resolveFileIcon("apps/storefront-ui/src/app/user/user.service.ts", DEFAULT_ICON_RULES)).toBe("angular-service");
    expect(resolveFileIcon("web-frontend/src/app/auth/auth.guard.ts", DEFAULT_ICON_RULES)).toBe("angular-guard");
    expect(resolveFileIcon("web-frontend/src/app/app.module.ts", DEFAULT_ICON_RULES)).toBe("angular");
  });

  it("recognizes each framework's unmistakable file kinds anywhere", () => {
    expect(resolveFileIcon("libs/shared/src/user.controller.ts", DEFAULT_ICON_RULES)).toBe("nest-controller");
    expect(resolveFileIcon("libs/shared/src/events.gateway.ts", DEFAULT_ICON_RULES)).toBe("nest-gateway");
    expect(resolveFileIcon("libs/shared/src/user.component.ts", DEFAULT_ICON_RULES)).toBe("angular-component");
  });

  it("leaves files no rule matches to the file name", () => {
    expect(resolveFileIcon("apps/backend/src/user/user.dto.ts", DEFAULT_ICON_RULES)).toBe("dto");
    expect(resolveFileIcon("apps/backend/src/main.ts", DEFAULT_ICON_RULES)).toBe("typescript");
    expect(resolveFileIcon("libs/shared/src/user.service.ts", DEFAULT_ICON_RULES)).toBe("service");
    expect(resolveFileIcon("user.service.ts", [])).toBe("typescript");
  });

  it("takes the first matching rule and skips rules with an empty glob or an unknown icon", () => {
    const rules: IconRule[] = [
      { glob: "", icon: "rust" },
      { glob: "*.gql.ts", icon: "no-such-icon" },
      { glob: "*.gql.ts", icon: "graphql" },
      { glob: "src/**", icon: "angular" },
      { glob: "src/**", icon: "nest" },
    ];
    expect(resolveFileIcon("src/user.gql.ts", rules)).toBe("graphql");
    expect(resolveFileIcon("src/user.service.ts", rules)).toBe("angular");
    expect(resolveFileIcon("lib/user.controller.ts", rules)).toBe("typescript");
  });
});

describe("iconUrl", () => {
  it("returns the bundled URL for a shipped icon and null otherwise", () => {
    expect(iconUrl("nest")).toMatch(/\/nest\.svg$/);
    expect(iconUrl("no-such-icon")).toBeNull();
  });
});

describe("fileIconUrl", () => {
  it("applies the current icon rules to a worktree-relative path", () => {
    expect(fileIconUrl("apps/api/src/user.controller.ts")).toMatch(/\/nest-controller\.svg$/);
  });

  it("resolves well-known file names and extensions", () => {
    expect(fileIconUrl("package.json")).toMatch(/\/package-json\.svg$/);
    expect(fileIconUrl("main.rs")).toMatch(/\/rust\.svg$/);
    expect(fileIconUrl("README.md")).toMatch(/\/readme\.svg$/);
    expect(fileIconUrl(".gitignore")).toMatch(/\/git\.svg$/);
  });

  it("prefers the longest matching extension chain", () => {
    expect(fileIconUrl("user.spec.ts")).toMatch(/\/typescript-test\.svg$/);
    expect(fileIconUrl("user.ts")).toMatch(/\/typescript\.svg$/);
  });

  it("resolves the building-block suffixes through the default rules, not the file name", () => {
    expect(resolveFileIcon("user.service.ts", DEFAULT_ICON_RULES)).toBe("service");
    expect(resolveFileIcon("user.api-service.ts", DEFAULT_ICON_RULES)).toBe("service");
    expect(resolveFileIcon("user.repository.ts", DEFAULT_ICON_RULES)).toBe("repository");
    expect(resolveFileIcon("user.entity.ts", DEFAULT_ICON_RULES)).toBe("entity");
    expect(resolveFileIcon("address.embeddable.ts", DEFAULT_ICON_RULES)).toBe("embeddable");
    expect(resolveFileIcon("money.value-object.ts", DEFAULT_ICON_RULES)).toBe("value-object");
    expect(resolveFileIcon("user.query.ts", DEFAULT_ICON_RULES)).toBe("queries");
    expect(resolveFileIcon("user.spec-sqlite.ts", DEFAULT_ICON_RULES)).toBe("typescript-test");
    expect(resolveFileIcon("user.repository.ts", [])).toBe("typescript");
  });

  it("matches names case-insensitively", () => {
    expect(fileIconUrl("Dockerfile")).toBe(fileIconUrl("dockerfile"));
  });

  it("falls back to the generic file icon for unknown names", () => {
    expect(fileIconUrl("foo.unknownext")).toMatch(/\/_file\.svg$/);
  });
});

describe("folderIconUrl", () => {
  it("resolves folder names case-insensitively, with an open state", () => {
    expect(folderIconUrl("src")).toMatch(/\/folder_src\.svg$/);
    expect(folderIconUrl("NODE_MODULES", true)).toMatch(/\/folder_node_open\.svg$/);
  });

  it("falls back to the generic folder icons for unknown names", () => {
    expect(folderIconUrl("some-unknown-dir")).toMatch(/\/_folder\.svg$/);
    expect(folderIconUrl("some-unknown-dir", true)).toMatch(/\/_folder_open\.svg$/);
    expect(rootFolderIconUrl(true)).toMatch(/\/_root_open\.svg$/);
  });
});
