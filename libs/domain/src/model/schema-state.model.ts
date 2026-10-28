import type * as z from "zod/mini";

/** A schema whose output is an object: the shape every model's state has. */
export type StateSchema = z.ZodMiniType<Record<string, unknown>>;

/**
 * The class side of a schema-state model. `schema` is optional only because TypeScript can neither require nor
 * inherit-declare a static on a subclass: declaring it on the base would force every model to write `static override`,
 * so the contract is checked at construction instead.
 */
interface SchemaStateModelClass {
  readonly schema?: StateSchema;
  readonly name: string;
}

/**
 * Base of the models whose defining attributes live in a schema-parsed state object that is proxied onto the instance
 * as plain properties: `ValueObject` for identity-free values, `DomainModel` for aggregates with a lifecycle.
 *
 * Each model declares its schema as `static readonly schema`, which the constructor reads off the most-derived class, so
 * the schema is reachable before any instance exists and named exactly once per model. The state is parsed at
 * construction, so an instance can never exist unvalidated. Writes through the proxied properties go straight to the
 * state without re-validation; a mutating method wraps its change in `changeState`, which restores the last valid state
 * when the schema rejects the change. Derived values belong on the subclass as prototype getters: they take precedence
 * over state keys of the same name and stay out of enumeration.
 */
export abstract class SchemaStateModel<T extends StateSchema = StateSchema> {
  declare protected readonly _schema: T;
  declare protected readonly _state: z.infer<T>;
  /** A shallow copy of the state as of the last successful parse, which a failed validation restores. */
  declare private _lastValidState: Record<string, unknown>;

  protected constructor(value: unknown) {
    // `new.target` is the model class being constructed, so the schema comes from the most-derived subclass.
    const { schema, name }: SchemaStateModelClass = new.target;
    if (!schema) throw new Error(`${name} must declare a static schema`);
    const state = schema.parse(value);
    // Non-enumerable, so spreads, Object.keys and structural matchers see only the proxied attributes.
    Object.defineProperty(this, "_schema", { value: schema, enumerable: false });
    Object.defineProperty(this, "_state", { value: state, enumerable: false });
    Object.defineProperty(this, "_lastValidState", { value: { ...state }, enumerable: false, writable: true });
    this.defineStateAccessors(state);
  }

  /**
   * Runs `change`, which may assign the proxied attributes, and re-parses the state through the schema. When the schema
   * rejects the changed state, the attributes are restored to the last valid state and the error rethrown, so a
   * rejected change never sticks. Every mutating method of a model wraps its change in this.
   */
  protected changeState(change: () => void): void {
    change();
    this.validate();
  }

  /** Re-parses the current state through the schema; restores the last valid state and rethrows on a rejection. */
  protected validate(): void {
    const state: Record<string, unknown> = this._state;
    try {
      Object.assign(state, this._schema.parse(state));
      this._lastValidState = { ...state };
    } catch (error) {
      Object.assign(state, this._lastValidState);
      throw error;
    }
  }

  /** Proxies each state property onto the instance; existing class members win. */
  private defineStateAccessors(state: Record<string, unknown>): void {
    for (const key of Object.keys(state)) {
      if (key in this) continue;
      Object.defineProperty(this, key, {
        get: () => state[key],
        set: (newValue: unknown) => {
          state[key] = newValue;
        },
        enumerable: true,
        configurable: false,
      });
    }
  }
}
