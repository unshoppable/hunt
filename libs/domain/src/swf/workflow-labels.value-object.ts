import * as z from "zod/mini";
import { ValueObject } from "../model/value-object.model.ts";
import { isSwfStep, SWF_STEPS, type AgentState, type SwfStep } from "./swf-step.types.ts";

const STEP_DESCRIPTIONS: Record<SwfStep, string> = {
  plan: "Hunt's agent reads the issue and plans",
  implement: "Hunt's agent implements on a session VM",
  verify: "Hunt's agent checks its change against the issue",
  gate: "Hunt's agent judges whether a person has to review",
  pr: "Hunt's agent opens the pull request",
  review: "The pull request waits for its checks and the Claude review",
  "human-review": "A person has to review the pull request",
  merge: "Hunt merges the pull request",
};

const ZodWorkflowLabelsState = z.object({
  label: z.string().check(z.regex(/^[^\s:]+$/, "the label of the workflow has no colon and no whitespace")),
});

/** A repository label as the poller creates it. */
export interface LabelSpec {
  name: string;
  color: string;
  description: string;
}

/** The issue the labels describe, as far as the agent state goes. */
export interface LabelledIssue {
  state: "open" | "closed";
  labels: string[];
}

export interface WorkflowLabels extends z.infer<typeof ZodWorkflowLabelsState> {}

/**
 * The labels the poller works with for the configured `label`: the label itself asks for a session, `<label>:<step>`
 * marks the step of the pipeline, and `<label>:question`, `<label>:done` and `<label>:failed` its outcomes.
 */
export class WorkflowLabels extends ValueObject<typeof ZodWorkflowLabelsState> {
  static readonly schema = ZodWorkflowLabelsState;

  constructor(value: z.input<typeof ZodWorkflowLabelsState>) {
    super(value);
  }

  static of(label: string): WorkflowLabels {
    return new WorkflowLabels({ label });
  }

  /** The label that asks for a session. */
  get requested(): string {
    return this.label;
  }

  /** The agent asked a question on the issue and waits for the answer. */
  get question(): string {
    return `${this.label}:question`;
  }

  get done(): string {
    return `${this.label}:done`;
  }

  get failed(): string {
    return `${this.label}:failed`;
  }

  /** `<label>:<step>` while the pipeline is at that step. */
  step(step: SwfStep): string {
    return `${this.label}:${step}`;
  }

  /** The step `name` labels; null for any other label. */
  stepOf(name: string): SwfStep | null {
    const prefix = `${this.label}:`;
    if (!name.startsWith(prefix)) return null;
    const step = name.slice(prefix.length);
    return isSwfStep(step) ? step : null;
  }

  /** The repository labels the poller creates when they are missing; the human review in red. */
  specs(): LabelSpec[] {
    return [
      ...SWF_STEPS.map((step) => ({ name: this.step(step), color: step === "human-review" ? "e99695" : "fbca04", description: STEP_DESCRIPTIONS[step] })),
      { name: this.question, color: "d876e3", description: "Hunt's agent asked a question on this issue and waits for the answer" },
      { name: this.done, color: "0e8a16", description: "Hunt merged the pull request for this issue" },
      { name: this.failed, color: "d93f0b", description: "Hunt could not complete this issue" },
    ];
  }

  /**
   * The agent state the issue's labels report: `question` while the agent waits for an answer on the issue, `done` once
   * it finished (a closed or deleted issue counts as finished), `failed` when it gave up, else the step its label
   * names; null when the issue carries no label of the workflow.
   */
  agentStateOf(issue: LabelledIssue | null): AgentState | null {
    if (!issue) return "done";
    if (issue.labels.includes(this.question)) return "question";
    if (issue.labels.includes(this.done)) return "done";
    if (issue.labels.includes(this.failed)) return "failed";
    if (issue.state === "closed") return "done";
    for (const label of issue.labels) {
      const step = this.stepOf(label);
      if (step) return step;
    }
    return null;
  }

  /** The labels of the workflow `issue` carries, which a transition removes before it adds the next one. */
  carriedBy(issue: Pick<LabelledIssue, "labels">): string[] {
    return issue.labels.filter((label) => label === this.question || label === this.done || label === this.failed || this.stepOf(label) !== null);
  }
}
