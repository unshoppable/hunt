/** The claude.ai plan limits in display order: 5-hour, weekly, weekly per model; empty without plan limits (API key). */
export type PlanUsage = {
  subscriptionType: string | null;
  windows: UsageWindow[];
  /** Set when the usage endpoint refused the read for too many requests: seconds until it answers again. */
  retryAfterSeconds: number | null;
};

export type UsageWindow = {
  /** `5h`, `Week` or a model name such as `Fable`. */
  label: string;
  /** Percentage of the window used, 0–100. */
  utilization: number;
  /** ISO 8601 time the window resets. */
  resetsAt: string | null;
};
