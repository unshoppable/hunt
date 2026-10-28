import * as z from "zod/mini";
import { SchemaStateModel, type StateSchema } from "./schema-state.model.ts";

/**
 * Base of the value objects: identity-free values fully defined by their attributes and compared structurally. The
 * state mechanics (the `static schema` parsed at construction, the proxied attributes, the `changeState` rollback) come
 * from `SchemaStateModel`; a value object adds structural equality and JSON serialization.
 *
 * A subclass keeps its schema const module-local and exposes it as `static readonly schema`, types the proxied
 * attributes with a declaration merge and takes `z.input` of the schema in its constructor:
 *
 *   const ZodMonthPeriodState = z.object({ year: z.int(), month: z.int().check(z.minimum(1), z.maximum(12)) });
 *   export interface MonthPeriod extends z.infer<typeof ZodMonthPeriodState> {}
 *   export class MonthPeriod extends ValueObject<typeof ZodMonthPeriodState> {
 *     static readonly schema = ZodMonthPeriodState;
 *     constructor(value: z.input<typeof ZodMonthPeriodState>) {
 *       super(value);
 *     }
 *     get quarter(): number {
 *       return Math.ceil(this.month / 3);
 *     }
 *   }
 */
export class ValueObject<T extends StateSchema = StateSchema> extends SchemaStateModel<T> {
  constructor(value: z.input<T>) {
    super(value);
  }

  /** The model's schema wired to construct the value object, for a state that crossed a boundary as plain data. */
  static createParser<TValueObject extends ValueObject>(
    this: (new (value: never) => TValueObject) & { schema: StateSchema },
  ): z.ZodMiniType<TValueObject> {
    return z.pipe(this.schema, z.transform((state) => new this(state as never)));
  }

  /** Structural equality over the defining attributes; instances of different classes are never equal. */
  isEqualTo(other: ValueObject | null | undefined): boolean {
    if (!other) return false;
    if (other === this) return true;
    if (other.constructor !== this.constructor) return false;
    return isDeepValueEqual(this._state, other._state);
  }

  /** The plain defining attributes; derived getters of the subclass stay off the wire. */
  toJSON(): z.infer<T> {
    return { ...this._state };
  }
}

/** Strict structural comparison: Dates by their time, nested value objects by `isEqualTo`, arrays and plain objects deep. */
function isDeepValueEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  if (left instanceof ValueObject && right instanceof ValueObject) return left.isEqualTo(right);
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return left.every((item, index) => isDeepValueEqual(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftEntries = Object.entries(left);
    if (leftEntries.length !== Object.keys(right).length) return false;
    return leftEntries.every(([key, leftValue]) => key in right && isDeepValueEqual(leftValue, right[key]));
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
