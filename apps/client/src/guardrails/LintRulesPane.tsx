import { useMemo, useState } from "react";
import { SubChatPopover } from "../chat/sub-chat/SubChatPopover";
import { useSubChatPopover } from "../chat/sub-chat/sub-chat-popover.hook";
import { useFileIconUrl } from "../ui/file-icons/file-icons.hook";
import { commands } from "../ipc/commands";
import type { LintConfig, LintRuleOrigin, LintRules, LintSeverity } from "./lint-rules.types";
import { useHuntStore } from "../sessions/hunt.store";
import { AgentButton } from "../ui/AgentButton";
import { Chip } from "../ui/Chip";
import { ChevronIcon } from "../ui/Icons";
import { dirName } from "../common/path/path.utils";
import { SearchField } from "../ui/SearchField";
import { useLoad } from "../ui/load.hook";
import { errorText } from "../ui/error-text.utils";
import { useTreeNavigation } from "../ui/tree-navigation.hook";
import { filterLintEntries, lintRuleChat, lintRuleEntries, lintRuleRows, lintTask, optionsText, ORIGIN_GROUPS, scopeOf, type LintRuleEntry } from "./lint-rules.utils";

const SEVERITY_CHIP: Record<LintSeverity, string> = {
  error: "border-red-400/40 bg-red-400/10 text-red-300",
  warn: "border-amber-400/40 bg-amber-400/10 text-amber-300",
  off: "border-white/15 bg-white/5 text-neutral-400",
};

/** Key of an origin's group row in the list; it ends with a slash, which no rule id does. */
function groupKey(origin: LintRuleOrigin): string {
  return `${origin}/`;
}

/**
 * The Guardrails window's tab over the ESLint rules of the session's worktree (see `read_lint_rules`): every rule a
 * config sets, once, grouped by where it comes from and filtered by the search field, and on the right the selected
 * rule with its description and every config and file glob that sets it. The tab only reads; "Agent" opens a sub chat
 * (see chat/sub-chat/SubChatPopover.tsx) whose agent changes the rule from the user's instructions, and reopens it once it
 * exists. The rules are read again whenever `reloadVersion` changes.
 */
export function LintRulesPane({ sessionId, reloadVersion }: { sessionId: string; reloadVersion: number }) {
  const [rules, setRules] = useState<LintRules | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<LintRuleOrigin>>(new Set());
  const agentChat = useSubChatPopover();

  useLoad(
    () => commands.readLintRules(sessionId),
    {
      onValue: (next) => {
        setRules(next);
        setError(null);
      },
      onError: (reason) => setError(errorText(reason)),
    },
    [sessionId, reloadVersion],
  );

  const entries = useMemo(() => (rules ? lintRuleEntries(rules) : []), [rules]);
  const rows = lintRuleRows(filterLintEntries(entries, query), collapsedGroups);
  const selected = entries.find((entry) => entry.id === selectedId) ?? null;
  const brokenConfigs = rules?.configs.filter((config) => config.error || !config.installed) ?? [];

  const select = (id: string) => {
    setSelectedId(id);
    agentChat.close();
  };

  /** Opens or closes the group of `origin`; the groups have no subgroups. */
  const toggleGroup = (origin: LintRuleOrigin) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (!next.delete(origin)) {
        next.add(origin);
      }
      return next;
    });
  };

  const listNav = useTreeNavigation({
    rows: rows.map((row) => (row.type === "group" ? { key: groupKey(row.origin), depth: 0, isExpanded: !collapsedGroups.has(row.origin) } : { key: row.entry.id, depth: 1 })),
    selectedKey: selectedId,
    onSelect: select,
    isSelectable: (key) => !key.endsWith("/"),
    onToggle: (key) => toggleGroup(key.slice(0, -1) as LintRuleOrigin),
  });

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-96 shrink-0 flex-col border-r border-(--line) bg-(--surface-inset)">
        <SearchField value={query} onChange={setQuery} placeholder="Filter rules" ariaLabel="Filter the rules" className="m-2" />
        {brokenConfigs.length ? <BrokenConfigs configs={brokenConfigs} /> : null}
        <ul {...listNav.listProps} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 text-[13px] outline-none">
          {rows.map((row) =>
            row.type === "group" ? (
              <li key={groupKey(row.origin)} data-tree-key={groupKey(row.origin)}>
                <button
                  type="button"
                  onClick={() => {
                    toggleGroup(row.origin);
                    listNav.select(groupKey(row.origin));
                  }}
                  aria-expanded={!collapsedGroups.has(row.origin)}
                  className={`flex w-full items-center gap-1 rounded px-1 py-1.5 text-left ${listNav.cursor === groupKey(row.origin) ? "bg-(--row-selected) text-white" : "text-neutral-400 hover:bg-(--row-hover) hover:text-white"}`}
                >
                  <ChevronIcon expanded={!collapsedGroups.has(row.origin)} className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{row.label}</span>
                  <span className="shrink-0 text-neutral-500">{row.count}</span>
                </button>
              </li>
            ) : (
              <li key={row.entry.id} data-tree-key={row.entry.id}>
                <button
                  type="button"
                  onClick={() => listNav.select(row.entry.id)}
                  title={row.entry.description ?? row.entry.id}
                  className={`flex w-full items-center gap-2 rounded py-1.5 pr-2 pl-6 text-left ${listNav.cursor === row.entry.id ? "bg-(--row-selected) text-white" : "text-neutral-300 hover:bg-(--row-hover) hover:text-white"}`}
                >
                  <span className="min-w-0 flex-1 truncate">{row.entry.id}</span>
                  <Chip className={SEVERITY_CHIP[row.entry.severity]}>{row.entry.severity}</Chip>
                </button>
              </li>
            ),
          )}
          {rules && !rules.configs.length ? <li className="px-2 py-2 text-neutral-500">No ESLint config in this repository.</li> : null}
          {!!rules?.configs.length && !rows.length ? <li className="px-2 py-2 text-neutral-500">{query.trim() ? "No rule matches the filter." : "No config switches on a rule."}</li> : null}
          {!rules && !error ? <li className="px-2 py-2 text-neutral-500">Reading the ESLint config…</li> : null}
        </ul>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {error ? <p className="border-b border-(--line) px-4 py-1.5 text-[13px] text-red-400">{error}</p> : null}
        {selected ? (
          <RuleDetails sessionId={sessionId} entry={selected} onOpenAgent={agentChat.open} />
        ) : (
          <p className="m-auto text-[13px] text-neutral-500">{rules ? "Select a rule to see what it checks and where it is set." : null}</p>
        )}
        {agentChat.shown ? (
          <SubChatPopover
            key={agentChat.shown.key}
            parentSessionId={sessionId}
            request={agentChat.shown.request}
            subSessionId={agentChat.shown.subSessionId}
            title={selected ? `Change ${selected.id}` : "Change the lint rule"}
            placeholder="How should the rule change: severity, options, files, or remove it?"
            onClose={agentChat.close}
          />
        ) : null}
      </section>
    </div>
  );
}

/** Configs whose rules are missing from the list: ESLint does not resolve from them, or importing them failed. */
function BrokenConfigs({ configs }: { configs: LintConfig[] }) {
  return (
    <ul className="mx-2 mb-2 space-y-0.5 rounded-md border border-red-400/30 bg-red-400/5 px-2.5 py-1.5 text-[13px] text-red-300">
      {configs.map((config) => (
        <li key={config.path} className="truncate" title={config.error ?? undefined}>
          {config.path}: {config.error ? `failed to load (${config.error})` : "ESLint is not installed; install the dependencies"}
        </li>
      ))}
    </ul>
  );
}

/** The selected rule: what it checks, where it comes from, and every config and file glob that sets it. */
function RuleDetails({ sessionId, entry, onOpenAgent }: { sessionId: string; entry: LintRuleEntry; onOpenAgent: ReturnType<typeof useSubChatPopover>["open"] }) {
  const fileIconUrl = useFileIconUrl();
  const task = lintTask(entry);
  const sessions = useHuntStore((state) => state.sessions);
  const ruleChat = useMemo(() => lintRuleChat(sessions, sessionId, task), [sessions, sessionId, task]);
  const isRuleChatBusy = useHuntStore((state) => (ruleChat ? (state.chats[ruleChat.sessionId]?.isBusy ?? false) : false));
  const isRuleChatUnseen = useHuntStore((state) => (ruleChat ? (state.chats[ruleChat.sessionId]?.hasUnseenActivity ?? false) : false));
  const originLabel = ORIGIN_GROUPS.find((group) => group.origin === entry.origin)?.label;

  /** Opens the sub chat about the rule below `button`: the existing one, or a new one about the first config that sets it. */
  const openAgent = (button: HTMLElement) => {
    const rect = button.getBoundingClientRect();
    const anchor = { x: rect.left, y: rect.bottom + 6 };
    if (ruleChat) {
      onOpenAgent({ selection: ruleChat.selection, anchor }, ruleChat.sessionId);
      return;
    }
    onOpenAgent({ selection: { path: entry.uses[0].configPath, startLine: 1, endLine: 1, text: "", task }, anchor });
  };

  return (
    <>
      <div className="@container flex shrink-0 items-center gap-2 border-b border-(--line) px-3 py-2.5 text-[13px]">
        {entry.url ? (
          <a href={entry.url} className="min-w-0 truncate font-mono text-neutral-100 hover:underline" title={entry.url}>
            {entry.id}
          </a>
        ) : (
          <span className="min-w-0 truncate font-mono text-neutral-100">{entry.id}</span>
        )}
        <Chip className={entry.origin === "repository" ? "border-blue-400/40 bg-blue-400/10 text-blue-300" : "border-white/15 bg-white/5 text-neutral-400"}>{originLabel}</Chip>
        <span className="flex-1" />
        <AgentButton
          label="Agent"
          labelClassName="hidden @xl:inline"
          onClick={(event) => openAgent(event.currentTarget)}
          isBusy={isRuleChatBusy}
          hasUnseenReply={isRuleChatUnseen}
          title={ruleChat ? "Show the agent's chat about this rule" : "Let the agent change this rule from your instructions"}
          aria-label={ruleChat ? "Show the agent's chat about this rule" : "Let the agent change this rule from your instructions"}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[13px]">
        <p className="text-[14px] text-neutral-200">{entry.description ?? "The rule documents no description."}</p>
        <h3 className="mt-4 mb-1.5 font-semibold text-neutral-300">Set in</h3>
        <ul className="divide-y divide-(--line) rounded-md border border-(--line)">
          {entry.uses.map((use, index) => {
            const options = optionsText(use.options);
            return (
              <li key={index} className="px-2.5 py-2">
                <div className="flex items-center gap-2">
                  <img src={fileIconUrl(use.configPath)} alt="" className="size-4 shrink-0" />
                  <span className="min-w-0 truncate text-neutral-200" title={use.configPath}>
                    {dirName(use.configPath) || "Repository root"}
                  </span>
                  <Chip className={SEVERITY_CHIP[use.severity]}>{use.severity}</Chip>
                </div>
                <p className="mt-0.5 font-mono break-all text-neutral-400">{scopeOf(use)}</p>
                {options ? <pre className="mt-1.5 overflow-x-auto rounded bg-(--surface-inset) px-2 py-1.5 font-mono text-neutral-300">{options}</pre> : null}
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}
