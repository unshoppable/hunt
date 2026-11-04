import { baseName, dirName } from "../../common/path/path.utils";
import type { LoadedContextFile, LoadedContextKind, LoadTrigger } from "./loaded-context.types";

/** The sections of the loaded-context popover in the order they are shown, with their headings. */
const SECTIONS: { kind: LoadedContextKind; title: string }[] = [
  { kind: "instructions", title: "Instruction files" },
  { kind: "rule", title: "Rules" },
  { kind: "skill", title: "Skills" },
  { kind: "adr", title: "ADRs" },
  { kind: "resource", title: "Other files" },
  { kind: "memory", title: "Memory" },
];

export const TRIGGER_LABELS: Record<LoadTrigger, string> = {
  start: "at start",
  path: "by path",
  invoked: "invoked",
  read: "read",
};

export type LoadedContextSection = { kind: LoadedContextKind; title: string; files: LoadedContextFile[] };

/** `files` grouped into the popover's sections, in load order within each; empty sections are left out. */
export function contextSections(files: LoadedContextFile[]): LoadedContextSection[] {
  return SECTIONS.map(({ kind, title }) => ({ kind, title, files: files.filter((file) => file.kind === kind) })).filter((section) => section.files.length);
}

/** The name a file is listed under, a skill's folder name for its `SKILL.md`, and the folder shown beside it. */
export function contextFileLabel(file: LoadedContextFile): { name: string; folder: string } {
  const folder = dirName(file.path);
  return file.kind === "skill" ? { name: baseName(folder), folder: dirName(folder) } : { name: baseName(file.path), folder };
}
