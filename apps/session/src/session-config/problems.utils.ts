/**
 * The plumbing of the hand-ordered walk of a document such as hunt.json (`hunt-json.value-object.ts`): `Problems`
 * collects each problem with the path of the offending value, `at` and `appendPath` spell those paths, `record` reads an
 * object and reports its unknown fields, `parseField` checks one value against its zod rule (`hunt-json.rules.ts`).
 */
import type * as z from "zod/mini";
import { isRecord } from "../../../../libs/domain/src/shared/json-rpc.utils.ts";

/** Collects the problems of a document; `add` returns undefined, so a check can `return problems.add(…)`. */
export class Problems {
  readonly messages: string[] = [];

  add(path: string, message: string): undefined {
    this.messages.push(`${path}: ${message}`);
    return undefined;
  }
}

/** The path of `key` in the object at `path`; an empty `path` is the root of the document. */
export function at(path: string, key: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) return `${path}[${JSON.stringify(key)}]`;
  return path ? `${path}.${key}` : key;
}

/** `path` extended by the keys and indices of `segments`, as a zod issue names the place of its value. */
export function appendPath(path: string, segments: readonly PropertyKey[]): string {
  let extended = path;
  for (const segment of segments) {
    extended = typeof segment === "number" ? `${extended}[${segment}]` : at(extended, String(segment));
  }
  return extended;
}

/** `value` as an object; keys outside `fields` are reported as unknown unless `fields` is null. */
export function record(value: unknown, path: string, fields: readonly string[] | null, problems: Problems): Record<string, unknown> | undefined {
  if (!isRecord(value)) return problems.add(path, "must be an object");
  for (const key of Object.keys(value)) {
    if (fields && !fields.includes(key)) {
      problems.add(at(path, key), "unknown field");
    }
  }
  return value;
}

/** `value` parsed by `schema`; undefined when the schema rejects it, with each of its issues reported at its path below `path`. */
export function parseField<TSchema extends z.ZodMiniType>(schema: TSchema, value: unknown, path: string, problems: Problems): z.output<TSchema> | undefined {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    problems.add(appendPath(path, issue.path), issue.message);
  }
  return undefined;
}

/** Like `parseField` for an optional field: undefined without a value, so that the state schema's default applies. */
export function parseOptionalField<TSchema extends z.ZodMiniType>(
  schema: TSchema,
  value: unknown,
  path: string,
  problems: Problems,
): z.output<TSchema> | undefined {
  if (value === undefined) return undefined;
  return parseField(schema, value, path, problems);
}
