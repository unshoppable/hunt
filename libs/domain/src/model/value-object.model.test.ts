import { describe, expect, it } from "vitest";
import * as z from "zod/mini";
import { DomainModel } from "./domain.model.ts";
import { ValueObject } from "./value-object.model.ts";

const ZodMonthPeriodState = z.object({ year: z.int(), month: z.int().check(z.minimum(1), z.maximum(12)) });

interface MonthPeriod extends z.infer<typeof ZodMonthPeriodState> {}

class MonthPeriod extends ValueObject<typeof ZodMonthPeriodState> {
  static readonly schema = ZodMonthPeriodState;

  constructor(value: z.input<typeof ZodMonthPeriodState>) {
    super(value);
  }

  get quarter(): number {
    return Math.ceil(this.month / 3);
  }
}

const ZodCounterState = z
  .object({ count: z.int().check(z.nonnegative()), limit: z.int(), reached: z.boolean() })
  .check(z.refine((state) => !state.reached || state.count >= state.limit, { message: "reached only at the limit", path: ["reached"] }));

interface Counter extends z.infer<typeof ZodCounterState> {}

class Counter extends DomainModel<typeof ZodCounterState> {
  static readonly schema = ZodCounterState;

  static start(limit: number): Counter {
    return new Counter({ count: 0, limit, reached: false });
  }

  constructor(value: z.input<typeof ZodCounterState>) {
    super(value);
  }

  increment(): void {
    this.changeState(() => {
      this.count += 1;
      this.reached = this.count >= this.limit;
    });
  }

  markReached(): void {
    this.changeState(() => {
      this.reached = true;
    });
  }
}

describe("ValueObject", () => {
  it("parses its state at construction, proxies the attributes and keeps derived getters off the wire", () => {
    const period = new MonthPeriod({ year: 2026, month: 5 });
    expect(period.year).toBe(2026);
    expect(period.quarter).toBe(2);
    expect(Object.keys(period)).toEqual(["year", "month"]);
    expect(JSON.stringify(period)).toBe('{"year":2026,"month":5}');
    expect(period).toEqual({ year: 2026, month: 5 });
  });

  it("rejects an invalid construction", () => {
    expect(() => new MonthPeriod({ year: 2026, month: 13 })).toThrow();
    expect(() => new (class extends ValueObject {})({})).toThrow(/must declare a static schema/);
  });

  it("compares structurally, never across classes", () => {
    class OtherPeriod extends ValueObject<typeof ZodMonthPeriodState> {
      static readonly schema = ZodMonthPeriodState;
    }
    const period = new MonthPeriod({ year: 2026, month: 5 });
    expect(period.isEqualTo(new MonthPeriod({ year: 2026, month: 5 }))).toBe(true);
    expect(period.isEqualTo(new MonthPeriod({ year: 2026, month: 6 }))).toBe(false);
    expect(period.isEqualTo(new OtherPeriod({ year: 2026, month: 5 }))).toBe(false);
    expect(period.isEqualTo(null)).toBe(false);
  });

  it("parses plain data into an instance through createParser", () => {
    const parsed = z.object({ period: MonthPeriod.createParser() }).parse({ period: { year: 2026, month: 2 } });
    expect(parsed.period).toBeInstanceOf(MonthPeriod);
    expect(parsed.period.quarter).toBe(1);
  });
});

describe("DomainModel", () => {
  it("applies an intent through changeState and serializes the state", () => {
    const counter = Counter.start(2);
    counter.increment();
    counter.increment();
    expect(counter.toJSON()).toEqual({ count: 2, limit: 2, reached: true });
  });

  it("rolls a rejected change back and rethrows", () => {
    const counter = Counter.start(3);
    expect(() => counter.markReached()).toThrow(/reached only at the limit/);
    expect(counter.reached).toBe(false);
    expect(counter.toJSON()).toEqual({ count: 0, limit: 3, reached: false });
  });
});
