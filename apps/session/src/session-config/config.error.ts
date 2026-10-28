/** Every problem found in a `hunt.json` or the session's host names, each starting with the path of the offending value. */
export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.name = "ConfigError";
    this.problems = problems;
  }
}
