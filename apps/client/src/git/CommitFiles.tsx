import { useMemo, useState } from "react";
import type { Commit, CommitDetails, CommitFile } from "../ipc/types";
import { buildChangeTree, type FolderNode, type TreeNode } from "../diff/changeTree";
import { useFileIconUrl, useFolderIconUrl } from "../diff/fileIcons";
import { STATUS_NAME_CLASS } from "../diff/styles";
import { ChevronIcon } from "../ui/icons";
import { RefChip, parseDecoration } from "./RefChip";

type Row = { node: TreeNode; depth: number };

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * The selected commit's files as a folder tree, followed by its details: message, author, committer, date, refs and
 * the branches containing it. A click on a file shows its change in the diff below.
 */
export function CommitFiles({
  commit,
  details,
  selectedPath,
  onSelect,
}: {
  commit: Commit | null;
  /** The commit's details once loaded; `null` while loading or without a commit. */
  details: CommitDetails | null;
  selectedPath: string | null;
  onSelect: (file: CommitFile) => void;
}) {
  const fileIconUrl = useFileIconUrl();
  const folderIconUrl = useFolderIconUrl();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const files = useMemo(() => (details && details.id === commit?.id ? details.files : []), [details, commit?.id]);
  const filesByPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  const tree = useMemo(() => buildChangeTree(files.map((file) => ({ path: file.path, status: file.status }))), [files]);

  const rows = useMemo(() => {
    const result: Row[] = [];
    const visit = (folder: FolderNode, depth: number) => {
      for (const child of folder.children) {
        result.push({ node: child, depth });
        if (child.kind === "folder" && !collapsed.has(child.path)) {
          visit(child, depth + 1);
        }
      }
    };
    visit(tree, 0);
    return result;
  }, [tree, collapsed]);

  const toggleCollapsed = (path: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const isLoaded = !!commit && details?.id === commit.id;

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-(--changelist-bg)">
      <div className="flex items-center gap-2 border-b border-(--line) px-3 py-2.5 text-[13px] text-neutral-400">
        <span className="flex-1 truncate">{commit ? (isLoaded ? `${files.length} ${files.length === 1 ? "file" : "files"}` : "Loading…") : "No commit selected"}</span>
        {commit ? <span className="font-mono text-neutral-500">{commit.id.slice(0, 8)}</span> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <ul className="py-1 font-(family-name:--changelist-font-family) text-(length:--changelist-font-size) leading-(--changelist-line-height)">
          {rows.map(({ node, depth }) =>
            node.kind === "folder" ? (
              <li
                key={`dir:${node.path}`}
                onClick={() => toggleCollapsed(node.path)}
                className="flex cursor-default items-center gap-[5px] pr-2 select-none hover:bg-(--row-hover)"
                style={{ paddingLeft: `calc(6px + ${depth} * var(--changelist-indent))` }}
                title={node.path}
              >
                <ChevronIcon expanded={!collapsed.has(node.path)} className="size-4 shrink-0 text-neutral-500" />
                <img src={folderIconUrl(node.path, !collapsed.has(node.path))} alt="" className="size-[17px] shrink-0" />
                <span className="truncate text-neutral-300">{node.name}</span>
                <span className="pl-1 text-[0.85em] text-neutral-600">{node.files.length}</span>
              </li>
            ) : (
              <li
                key={node.file.path}
                onClick={() => {
                  const file = filesByPath.get(node.file.path);
                  if (file) {
                    onSelect(file);
                  }
                }}
                className={`flex cursor-default items-center gap-[5px] pr-2 select-none ${selectedPath === node.file.path ? "bg-(--tree-selection)" : "hover:bg-(--row-hover)"}`}
                style={{ paddingLeft: `calc(26px + ${depth} * var(--changelist-indent))` }}
                title={`${node.file.path} (${node.file.status})`}
              >
                <img src={fileIconUrl(node.file.path)} alt="" className="size-[17px] shrink-0" />
                <span className={`truncate ${STATUS_NAME_CLASS[node.file.status] ?? "text-neutral-200"}`}>{node.name}</span>
                {filesByPath.get(node.file.path)?.oldPath ? <span className="truncate pl-1 text-[0.85em] text-neutral-500">- renamed from {filesByPath.get(node.file.path)?.oldPath}</span> : null}
              </li>
            ),
          )}
        </ul>
        {commit ? <Details commit={commit} details={isLoaded ? details : null} /> : null}
      </div>
    </div>
  );
}

function Details({ commit, details }: { commit: Commit; details: CommitDetails | null }) {
  const message = details?.message ?? commit.subject;
  const [subject, ...bodyLines] = message.split("\n");
  const body = bodyLines.join("\n").trim();
  const isCommitterDifferent = !!details && details.committer !== commit.author;
  return (
    <div className="border-t border-(--line) px-3 py-3 text-[13px] text-neutral-300">
      <p className="font-mono text-[14px] font-medium whitespace-pre-wrap text-neutral-100">{subject}</p>
      {body ? <p className="mt-2 font-mono whitespace-pre-wrap text-neutral-400">{body}</p> : null}
      <p className="mt-3 text-neutral-400">
        <span className="font-mono text-neutral-300">{commit.id.slice(0, 8)}</span> {commit.author} <span className="text-neutral-500">&lt;{commit.authorEmail}&gt;</span> on{" "}
        {DATE_FORMAT.format(new Date(commit.authoredAt))}
      </p>
      {isCommitterDifferent && details ? (
        <p className="mt-1 text-neutral-500">
          committed by {details.committer} on {DATE_FORMAT.format(new Date(details.committedAt))}
        </p>
      ) : null}
      {commit.refs.length ? (
        <p className="mt-2 flex flex-wrap items-center gap-1.5">
          {commit.refs.map((decoration) => (
            <RefChip key={decoration} chip={parseDecoration(decoration)} />
          ))}
        </p>
      ) : null}
      {details ? (
        <p className="mt-2 text-neutral-400" title={details.branches.join(", ")}>
          {details.branches.length ? `In ${details.branches.length} ${details.branches.length === 1 ? "branch" : "branches"}: ${details.branches.join(", ")}` : "In no branch"}
        </p>
      ) : null}
    </div>
  );
}
