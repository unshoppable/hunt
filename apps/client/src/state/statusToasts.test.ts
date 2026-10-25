import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TOASTS, SUCCESS_TOAST_MS, reportFailure, reportSuccess, useStatusToastStore, withToast, type StatusToast } from "./statusToasts";

const toast = (id: number): StatusToast => ({ id, tone: "success", message: `toast ${id}` });

describe("withToast", () => {
  it("appends the new toast", () => {
    expect(withToast([toast(1)], toast(2)).map((shown) => shown.id)).toEqual([1, 2]);
  });

  it("drops the oldest beyond MAX_TOASTS", () => {
    const full = Array.from({ length: MAX_TOASTS }, (_, index) => toast(index + 1));
    expect(withToast(full, toast(MAX_TOASTS + 1)).map((shown) => shown.id)).toEqual(Array.from({ length: MAX_TOASTS }, (_, index) => index + 2));
  });
});

describe("useStatusToastStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useStatusToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes a success after SUCCESS_TOAST_MS", () => {
    reportSuccess("Pushed main");
    vi.advanceTimersByTime(SUCCESS_TOAST_MS - 1);
    expect(useStatusToastStore.getState().toasts.map((shown) => shown.message)).toEqual(["Pushed main"]);
    vi.advanceTimersByTime(1);
    expect(useStatusToastStore.getState().toasts).toEqual([]);
  });

  it("keeps a failure until it is dismissed", () => {
    reportFailure("failed to push main");
    vi.advanceTimersByTime(SUCCESS_TOAST_MS * 10);
    const [failure] = useStatusToastStore.getState().toasts;
    expect(failure).toMatchObject({ tone: "error", message: "failed to push main" });
    useStatusToastStore.getState().dismissToast(failure.id);
    expect(useStatusToastStore.getState().toasts).toEqual([]);
  });
});
