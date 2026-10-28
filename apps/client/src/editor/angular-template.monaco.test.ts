import { describe, expect, it } from "vitest";
import { templateRoleOfHover } from "./angular-template.monaco";

describe("templateRoleOfHover", () => {
  it("reads a computed signal, printed as its call signature, as a signal", () => {
    expect(templateRoleOfHover("protected (property) EmployeeCardComponent.displayName: () => string")).toBe("signal");
  });

  it("reads an input, model or writable signal as a signal", () => {
    expect(templateRoleOfHover("(property) EmployeeCardComponent.employee: InputSignal\n() => Employee")).toBe("signal");
    expect(templateRoleOfHover("(property) Dialog.isOpen: ModelSignal<boolean>")).toBe("signal");
    expect(templateRoleOfHover("protected (property) Dialog.query: WritableSignal<string>")).toBe("signal");
  });

  it("reads a method as an instance method", () => {
    expect(templateRoleOfHover("protected (method) QualificationsPage.hasInvalidMapping(term: Term): boolean")).toBe("instanceMethod");
  });

  it("reads any other component property as an instance field", () => {
    expect(templateRoleOfHover("protected (property) EmployeeCardComponent.fieldLabelKeys: Record<EmployeeImportField, string>")).toBe("instanceField");
    expect(templateRoleOfHover("(property) Table<T>.rows: T[]")).toBe("instanceField");
  });

  it("leaves template variables, references and pipes to the grammar", () => {
    expect(templateRoleOfHover("(variable) const row: EmployeeImportDiffRow")).toBeNull();
    expect(templateRoleOfHover("(reference) diffValue: TemplateRef<any>")).toBeNull();
    expect(templateRoleOfHover("(pipe) UsTranslocoPipe.transform(keyPath: string): any")).toBeNull();
  });
});
