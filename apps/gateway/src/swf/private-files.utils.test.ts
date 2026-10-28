import { describe, expect, it } from "vitest";
import { Repository } from "../../../../libs/domain/src/session/repository.value-object.ts";
import { checkPrivateFilesArchive, privateFilesSecret } from "./private-files.utils.ts";

describe("private files", () => {
  it("names the secret of a repository's private files HUNT_SWF_FILES_<owner>_<repo>", () => {
    expect(privateFilesSecret(Repository.fromSlug("unshoppable/app-framework"))).toBe("HUNT_SWF_FILES_unshoppable_app-framework");
    expect(privateFilesSecret(Repository.fromSlug("acme/my.app"))).toBe("HUNT_SWF_FILES_acme_my_app");
  });

  it("accepts only a gzipped archive as private files", () => {
    expect(() => checkPrivateFilesArchive(Buffer.from([0x1f, 0x8b, 0x08, 0x00]), "HUNT_SWF_FILES_acme_app")).not.toThrow();
    expect(() => checkPrivateFilesArchive(Buffer.from("OPENAI_API_KEY=x\n"), "HUNT_SWF_FILES_acme_app")).toThrow(
      "the secret HUNT_SWF_FILES_acme_app is no gzipped tar archive (tar -czf - <files> | gcloud secrets versions add HUNT_SWF_FILES_acme_app --data-file=-)",
    );
    expect(() => checkPrivateFilesArchive(Buffer.alloc(0), "s")).toThrow("the secret s is no gzipped tar archive");
  });
});
