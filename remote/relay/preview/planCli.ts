/**
 * Builds the plan of a session's preview from its repository's `hunt.json` (see `contract.ts`); `hunt-ctl` runs it in
 * a sandbox container without network:
 *
 *   node /opt/hunt/relay/preview/planCli.ts --session <uuid> --domain <domain> [--with <process>]… < hunt.json
 *
 * Prints the plan as one line of JSON on stdout. An invalid `hunt.json` or invalid arguments print every problem on
 * stderr, one per line, and exit with 1.
 */
import { readFileSync } from "node:fs";
import { messageOf } from "../relay.ts";
import { buildPlan, ContractError, type PlanOptions } from "./contract.ts";

function parseArguments(args: string[]): PlanOptions {
  let sessionId: string | undefined;
  let domain: string | undefined;
  const withOptional: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = [args[index], args[index + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--session") {
      sessionId = value;
    } else if (flag === "--domain") {
      domain = value;
    } else if (flag === "--with") {
      withOptional.push(value);
    } else {
      throw new Error(`unknown argument ${flag}; usage: planCli.ts --session <uuid> --domain <domain> [--with <process>]… < hunt.json`);
    }
  }
  if (!sessionId || !domain) throw new Error("--session and --domain are required");
  return { sessionId, domain, withOptional };
}

function main(): void {
  try {
    const options = parseArguments(process.argv.slice(2));
    let huntJson: unknown;
    try {
      huntJson = JSON.parse(readFileSync(0, "utf8"));
    } catch (error) {
      throw new Error(`hunt.json is not valid JSON: ${messageOf(error)}`);
    }
    process.stdout.write(`${JSON.stringify(buildPlan(huntJson, options))}\n`);
  } catch (error) {
    const problems = error instanceof ContractError ? error.problems : [messageOf(error)];
    process.stderr.write(problems.map((problem) => `${problem}\n`).join(""));
    process.exitCode = 1;
  }
}

main();
