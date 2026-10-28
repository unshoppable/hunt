import * as z from "zod/mini";
import { ValueObject } from "../../../../libs/domain/src/model/value-object.model.ts";

const NAME_RULE = "must be a non-empty string";
const COMMAND_RULE = "must be an absolute path";
const ARGS_RULE = "must be an array of strings";
const ENV_RULE = "must be an array of {name, value} strings";

const ZodEnvVariable = z.object({ name: z.string({ error: ENV_RULE }), value: z.string({ error: ENV_RULE }) }, { error: ENV_RULE });

const ZodMcpServerState = z.object(
  {
    name: z.string({ error: NAME_RULE }).check(z.minLength(1, NAME_RULE)),
    command: z.string({ error: COMMAND_RULE }).check(z.startsWith("/", COMMAND_RULE)),
    args: z._default(z.array(z.string({ error: ARGS_RULE }), { error: ARGS_RULE }), () => []),
    env: z._default(z.array(ZodEnvVariable, { error: ENV_RULE }), () => []),
  },
  { error: "must be an object" },
);

export interface McpServer extends z.infer<typeof ZodMcpServerState> {}

/**
 * An MCP server the adapter starts for the session: ACP's stdio entry, which the relay passes on `session/new` and
 * `session/load` as its JSON. Fields ACP's entry does not have are dropped.
 */
export class McpServer extends ValueObject<typeof ZodMcpServerState> {
  static readonly schema = ZodMcpServerState;

  constructor(value: z.input<typeof ZodMcpServerState>) {
    super(value);
  }

  /** The server that `entry`, the entry at `path` of a list, describes; throws the first rule it breaks, as `<path>.<field> <rule>`. */
  static fromEntry(entry: unknown, path: string): McpServer {
    const parsed = ZodMcpServerState.safeParse(entry);
    if (parsed.success) return new McpServer(parsed.data);
    const { path: issuePath, message } = parsed.error.issues[0];
    throw new Error(issuePath.length ? `${path}.${String(issuePath[0])} ${message}` : `${path} ${message}`);
  }
}
