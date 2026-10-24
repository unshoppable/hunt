import { useState } from "react";
import { SubChatPopover, useSubChatPopover } from "../chat/SubChatPopover";
import { useFileIconUrl } from "../diff/fileIcons";
import { useSelectionChats } from "../ide/selectionChats";
import { commands } from "../ipc/commands";
import type { LintConfig, LintRule, LintRules, LintSeverity } from "../ipc/types";
import { useHuntStore } from "../state/store";
import { AgentButton } from "../ui/AgentButton";
import { Chip } from "../ui/Chip";
import { dirName } from "../ui/path";
import { SearchField } from "../ui/SearchField";
import { errorText, useLoad } from "../ui/useLoad";
import { useTreeNavigation } from "../ui/useTreeNavigation";
import { blockScope, enabledRuleCount, filterLintBlocks, lintTask, optionsText } from "./lintRules";

const SEVERITY_CHIP: Record<LintSeverity, string> = {
  error: "border-red-400/40 bg-red-400/10 text-red-300",
  warn: "border-amber-400/40 bg-amber-400/10 text-amber-300",
  off: "border-white/15 bg-white/5 text-neutral-400",
};

/**
 * The Guardrails window's tab over the ESLint rules of the session's worktree (see `read_lint_rules`): the configs on
 * the left, the selected config's blocks with their rules on the right, filtered by the search field. The tab only
 * reads; "Agent" opens a sub chat (see chat/SubChatPopover.tsx) whose agent changes the configuration from the user's
 * instructions, and reopens it once it exists. The rules are read again whenever `reloadVersion` changes.
 */
export function LintRulesPane({ sessionId, reloadVersion }: { sessionId: string; reloadVersion: number }) {
  const fileIconUrl = useFileIconUrl();
  const [rules, setRules] = useState<LintRules | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [query, setQuery] = useState("");
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

  const configs = rules?.configs ?? [];
  const selected = configs.find((config) => config.path === selectedPath) ?? configs[0] ?? null;
  const configChat = useSelectionChats(sessionId, selected?.path ?? null)[0] ?? null;
  const isConfigChatBusy = useHuntStore((state) => (configChat ? (state.chats[configChat.sessionId]?.isBusy ?? false) : false));

  const select = (path: string) => {
    setSelectedPath(path);
    agentChat.close();
  };

  const listNav = useTreeNavigation({
    rows: configs.map((config) => ({ key: config.path, depth: 0 })),
    selectedKey: selected?.path ?? null,
    onSelect: select,
    onToggle: () => {},
  });

  /** Opens the sub chat about the selected config below `button`: the existing one, or a new one. */
  const openAgent = (config: LintConfig, button: HTMLElement) => {
    const rect = button.getBoundingClientRect();
    const anchor = { x: rect.left, y: rect.bottom + 6 };
    if (configChat) {
      agentChat.open({ selection: configChat.selection, anchor }, configChat.sessionId);
      return;
    }
    agentChat.open({ selection: { path: config.path, startLine: 1, endLine: 1, text: "", task: lintTask(config.path) }, anchor });
  };

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-72 shrink-0 flex-col border-r border-(--line) bg-(--surface-inset)">
        <ul {...listNav.listProps} className="min-h-0 flex-1 overflow-y-auto p-2 text-[13px] outline-none">
          {configs.map((config) => (
            <li key={config.path} data-tree-key={config.path}>
              <button
                type="button"
                onClick={() => listNav.select(config.path)}
                title={config.path}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ${listNav.cursor === config.path ? "bg-(--row-selected) text-white" : "text-neutral-300 hover:bg-(--row-hover) hover:text-white"}`}
              >
                <img src={fileIconUrl(config.path)} alt="" className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{dirName(config.path) || "Repository root"}</span>
                {config.error ? (
                  <span className="shrink-0 text-red-400">failed</span>
                ) : (
                  <span className="shrink-0 text-neutral-500">{config.installed ? enabledRuleCount(config) : "no ESLint"}</span>
                )}
              </button>
            </li>
          ))}
          {rules && !configs.length ? <li className="px-2 py-2 text-neutral-500">No ESLint config in this repository.</li> : null}
          {!rules && !error ? <li className="px-2 py-2 text-neutral-500">Reading the ESLint config…</li> : null}
        </ul>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {error ? <p className="border-b border-(--line) px-4 py-1.5 text-[13px] text-red-400">{error}</p> : null}
        {selected ? (
          <>
            <div className="@container flex shrink-0 items-center gap-2 border-b border-(--line) px-3 py-2 text-[13px]">
              <img src={fileIconUrl(selected.path)} alt="" className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-neutral-400" title={selected.path}>
                {selected.path}
              </span>
              <SearchField value={query} onChange={setQuery} placeholder="Filter rules" ariaLabel="Filter the rules" className="w-64" />
              <AgentButton
                label="Agent"
                labelClassName="hidden @xl:inline"
                onClick={(event) => openAgent(selected, event.currentTarget)}
                isBusy={isConfigChatBusy}
                title={configChat ? "Show the agent's chat about the ESLint configuration" : "Let the agent change the ESLint configuration from your instructions"}
                aria-label={configChat ? "Show the agent's chat about the ESLint configuration" : "Let the agent change the ESLint configuration from your instructions"}
              />
            </div>
            <ConfigRules config={selected} query={query} />
          </>
        ) : null}
        {agentChat.shown ? (
          <SubChatPopover
            key={agentChat.shown.key}
            parentSessionId={sessionId}
            request={agentChat.shown.request}
            subSessionId={agentChat.shown.subSessionId}
            title="Change the ESLint configuration"
            placeholder="Which rule should change, be added or be removed, and for which files?"
            onClose={agentChat.close}
          />
        ) : null}
      </section>
    </div>
  );
}

/** The blocks of `config` that keep a rule matching `query`, each under the files it applies to. */
function ConfigRules({ config, query }: { config: LintConfig; query: string }) {
  if (!config.installed) return <p className="px-4 py-3 text-[13px] text-neutral-500">ESLint is not installed in this worktree; install its dependencies to list the rules.</p>;
  if (config.error) return <p className="px-4 py-3 text-[13px] text-red-400">Failed to load the config: {config.error}</p>;
  const blocks = filterLintBlocks(config, query);
  if (!blocks.length) {
    return <p className="px-4 py-3 text-[13px] text-neutral-500">{query.trim() ? "No rule matches the filter." : "The config switches on no rule of its own."}</p>;
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 text-[13px]">
      {blocks.map((block, index) => (
        <section key={index} className="mt-3">
          <h3 className="mb-1 truncate font-mono text-neutral-400" title={blockScope(block)}>
            {blockScope(block)}
          </h3>
          <ul className="divide-y divide-(--line) rounded-md border border-(--line)">
            {block.rules.map((rule) => (
              <RuleRow key={rule.id} rule={rule} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** One rule: its severity, id (a link to its documentation), origin, description and options. */
function RuleRow({ rule }: { rule: LintRule }) {
  const options = optionsText(rule.options);
  return (
    <li className="flex items-start gap-2 px-2.5 py-1.5">
      <Chip className={`mt-0.5 ${SEVERITY_CHIP[rule.severity]}`}>{rule.severity}</Chip>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {rule.url ? (
            <a href={rule.url} className="truncate font-mono text-neutral-100 hover:underline" title={rule.url}>
              {rule.id}
            </a>
          ) : (
            <span className="truncate font-mono text-neutral-100">{rule.id}</span>
          )}
          {rule.origin === "repository" ? (
            <Chip className="border-blue-400/40 bg-blue-400/10 text-blue-300" title="A plugin that lives in this repository">
              repository
            </Chip>
          ) : null}
        </div>
        {rule.description ? <p className="text-neutral-400">{rule.description}</p> : null}
        {options ? (
          <p className="truncate font-mono text-neutral-500" title={options}>
            {options}
          </p>
        ) : null}
      </div>
    </li>
  );
}
