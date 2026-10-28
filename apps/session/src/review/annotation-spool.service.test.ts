import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserAnnotation } from "../../../../libs/domain/src/review/browser-annotation.utils.ts";
import { AnnotationSpool } from "./annotation-spool.service.ts";

const ANNOTATION: BrowserAnnotation = {
  url: "https://7c0c6f2e-4200.hunt.example.com/orders",
  title: "Orders",
  selector: "#save",
  text: "Save",
  outerHtml: '<button id="save">Save</button>',
  rect: { x: 1, y: 2, width: 3, height: 4 },
  viewport: { width: 1280, height: 800 },
  styles: {},
  comment: "Make it blue",
};

describe("AnnotationSpool", () => {
  let dir = "";

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function createSpool(): AnnotationSpool {
    dir = mkdtempSync(join(tmpdir(), "hunt-spool-"));
    const spool = new AnnotationSpool(join(dir, "annotations"));
    spool.create();
    return spool;
  }

  it("creates its folder for its owner only", () => {
    const spool = createSpool();

    expect(statSync(spool.dir).mode & 0o777).toBe(0o700);
  });

  it("takes the stored annotations once, in the order of arrival, and deletes their files", () => {
    const spool = createSpool();
    const later = spool.store({ ...ANNOTATION, comment: "Later" }, 1_700_000_000_001);
    const first = spool.store(ANNOTATION, 1_700_000_000_000);

    expect(spool.takeAll()).toEqual([first, later]);
    expect(readdirSync(spool.dir)).toEqual([]);
    expect(spool.takeAll()).toEqual([]);
  });

  it("deletes a file that holds no annotation and reports it", () => {
    const spool = createSpool();
    const name = "1700000000000-00000000-0000-4000-8000-000000000000.json";
    writeFileSync(join(spool.dir, name), "{}");
    const invalid: string[] = [];

    expect(spool.takeAll((skipped) => invalid.push(skipped))).toEqual([]);
    expect(invalid).toEqual([name]);
    expect(readdirSync(spool.dir)).toEqual([]);
  });

  it("holds none while its folder is missing", () => {
    dir = mkdtempSync(join(tmpdir(), "hunt-spool-"));

    expect(new AnnotationSpool(join(dir, "missing")).takeAll()).toEqual([]);
  });

  it("is full once 200 annotations wait", () => {
    const spool = createSpool();
    for (let index = 0; index < 199; index++) {
      spool.store(ANNOTATION, 1_700_000_000_000 + index);
    }

    expect(spool.isFull()).toBe(false);
    spool.store(ANNOTATION);
    expect(spool.isFull()).toBe(true);
  });
});
