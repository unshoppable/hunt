import { AI_LANGUAGE_PRESETS, DEFAULT_AI_LANGUAGE, DEFAULT_GRAPH_AGENT, DEFAULT_SYSTEM_PROMPT, useSettingsStore } from "../settings.store";
import { findSelectOption, listChoices } from "../../chat/config-options.utils";
import { useAgentDefaultsStore } from "../../chat/agent-defaults.store";
import { AccountRow } from "../AccountRow";
import { PageHeader, TextArea, TextRow } from "../SettingsFields";

/**
 * Settings for the agent: the Claude account it runs on, the language of Hunt's own requests, the system prompt
 * addition and the model and effort of the diagram turns.
 */
export function AgentPage() {
  const aiLanguage = useSettingsStore((state) => state.aiLanguage);
  const setAiLanguage = useSettingsStore((state) => state.setAiLanguage);
  const systemPrompt = useSettingsStore((state) => state.systemPrompt);
  const setSystemPrompt = useSettingsStore((state) => state.setSystemPrompt);
  const graphAgent = useSettingsStore((state) => state.graphAgent);
  const setGraphAgent = useSettingsStore((state) => state.setGraphAgent);
  const knownOptions = useAgentDefaultsStore((state) => state.knownOptions);
  const isDefault =
    aiLanguage === DEFAULT_AI_LANGUAGE &&
    systemPrompt === DEFAULT_SYSTEM_PROMPT &&
    graphAgent.model === DEFAULT_GRAPH_AGENT.model &&
    graphAgent.effort === DEFAULT_GRAPH_AGENT.effort;
  const reset = () => {
    setAiLanguage(DEFAULT_AI_LANGUAGE);
    setSystemPrompt(DEFAULT_SYSTEM_PROMPT);
    setGraphAgent("model", DEFAULT_GRAPH_AGENT.model);
    setGraphAgent("effort", DEFAULT_GRAPH_AGENT.effort);
  };
  // The choices the agent offered last; the default model ID is not among them, since the agent lists it by alias.
  const choicesOf = (configId: string) => {
    const option = findSelectOption(knownOptions, configId);
    const choices = option ? listChoices(option).filter((choice) => choice.value !== "default") : [];
    return choices.map((choice) => ({ value: choice.value, label: choice.name }));
  };
  const modelPresets = [{ value: DEFAULT_GRAPH_AGENT.model }, ...choicesOf("model").filter((choice) => choice.value !== DEFAULT_GRAPH_AGENT.model)];

  return (
    <section>
      <PageHeader title="Agent" hint="Which account the agent runs on and what Hunt tells it on its own, without a prompt from you" isDefault={isDefault} onReset={reset} />
      <AccountRow />
      <div className="mt-5 flex flex-col gap-2">
        <TextRow
          label="Language"
          ariaLabel="Language of the agent output Hunt requests itself"
          value={aiLanguage}
          onChange={setAiLanguage}
          presets={AI_LANGUAGE_PRESETS.map((language) => ({ value: language }))}
        />
        <p className="text-[13px] leading-snug text-neutral-500">Applies to the labels and descriptions of the diagrams of the Architecture tab and to session summaries and titles. Your own prompts are answered in the language you write in.</p>
      </div>
      <div className="mt-5 flex flex-col gap-2">
        <div className="text-sm text-neutral-100">System prompt</div>
        <TextArea ariaLabel="System prompt addition for every agent session" value={systemPrompt} onChange={setSystemPrompt} />
        <p className="text-[13px] leading-snug text-neutral-500">Appended to Claude Code's own system prompt in every session started from now on, after the instructions of your CLAUDE.md files. Leave it empty to add nothing.</p>
      </div>
      <div className="mt-5 flex flex-col gap-2">
        <TextRow
          label="Diagram model"
          ariaLabel="Model the agent writes the diagrams of the Architecture tab with"
          value={graphAgent.model}
          onChange={(value) => setGraphAgent("model", value)}
          presets={modelPresets}
          isMonospace
        />
        <TextRow
          label="Diagram effort"
          ariaLabel="Effort the agent writes the diagrams of the Architecture tab with"
          value={graphAgent.effort}
          onChange={(value) => setGraphAgent("effort", value)}
          presets={choicesOf("effort")}
          isMonospace
        />
        <p className="text-[13px] leading-snug text-neutral-500">A separate background agent writes the diagrams of the Architecture tab with this model and effort, while the session's chat keeps its own and can go on working. A model option such as <code>opus</code> follows Claude Code to newer versions; a full model ID such as <code>claude-opus-5-5</code> stays on that version.</p>
      </div>
    </section>
  );
}
