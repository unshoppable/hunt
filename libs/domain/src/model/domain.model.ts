import type * as z from "zod/mini";
import { SchemaStateModel, type StateSchema } from "./schema-state.model.ts";

/**
 * Base of the domain models: an aggregate with a lifecycle whose business rules live on it. Its state is the schema
 * (invariants as `.refine`), every state change is a public intent method named in domain language that checks its
 * preconditions and applies the change through `changeState`, so an invalid state never sticks. The model does not
 * persist itself: the service or client that loaded it writes `toJSON()` back where it came from after each intent.
 */
export abstract class DomainModel<T extends StateSchema = StateSchema> extends SchemaStateModel<T> {
  protected constructor(value: z.input<T>) {
    super(value);
  }

  /** The plain state as the model's store writes it; derived getters of the subclass stay off the wire. */
  toJSON(): z.infer<T> {
    return { ...this._state };
  }
}
