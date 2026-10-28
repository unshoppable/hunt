import { describe, expect, it } from "vitest";
import { Repository } from "./repository.value-object.ts";

describe("Repository", () => {
  it("reads <owner>/<repo> and renders the slug and the URL path", () => {
    const repository = Repository.fromSlug("acme/my.app");
    expect(repository.toJSON()).toEqual({ owner: "acme", name: "my.app" });
    expect(repository.slug).toBe("acme/my.app");
    expect(repository.path).toBe("acme/my.app");
  });

  it("accepts the characters hunt-ctl accepts, with no part starting with a dot", () => {
    expect(["acme/app", "Acme-1/app_2.x", "a/b"].every((slug) => Repository.isSlug(slug))).toBe(true);
    for (const slug of ["", "acme", "acme/", "/app", "acme/app/extra", ".acme/app", "acme/.app", "acme/app name"]) {
      expect(Repository.isSlug(slug)).toBe(false);
      expect(() => Repository.fromSlug(slug)).toThrow();
    }
  });

  it("compares repositories without regard to case", () => {
    expect(Repository.fromSlug("Acme/App").isSameAs(Repository.fromSlug("acme/app"))).toBe(true);
    expect(Repository.fromSlug("acme/app").isSameAs(Repository.fromSlug("acme/other"))).toBe(false);
    expect(Repository.fromSlug("acme/app").isEqualTo(Repository.fromSlug("Acme/app"))).toBe(false);
  });
});
