import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { enumUrlCodec, numberUrlCodec, stringArrayUrlCodec, stringUrlCodec, useUrlState } from "./useUrlState";

describe("useUrlState", () => {
  it("hydrates from the URL and replaces only its own parameter", () => {
    window.history.replaceState({}, "", "/?view=map&price=420000");
    const { result } = renderHook(() => useUrlState("price", 250000, numberUrlCodec));

    expect(result.current[0]).toBe(420000);
    act(() => result.current[1](460000));

    expect(result.current[0]).toBe(460000);
    expect(window.location.search).toBe("?view=map&price=460000");
  });

  it("validates enum and array values", () => {
    window.history.replaceState({}, "", "/?mode=invalid&providers=Leboncoin,Unknown");
    const modeCodec = enumUrlCodec(["table", "cards"] as const);
    const providersCodec = stringArrayUrlCodec(["Leboncoin", "SeLoger"] as const);
    const mode = renderHook(() => useUrlState("mode", "cards" as const, modeCodec));
    const providers = renderHook(() => useUrlState("providers", ["SeLoger"] as const, providersCodec));

    expect(mode.result.current[0]).toBe("cards");
    expect(providers.result.current[0]).toEqual(["Leboncoin"]);

    act(() => providers.result.current[1]([]));
    expect(window.location.search).toContain("providers=-");
    expect(providers.result.current[0]).toEqual([]);
  });

  it("adopts an asynchronously resolved fallback while preserving explicit URL state", () => {
    window.history.replaceState({}, "", "/?view=builder");
    const { result, rerender } = renderHook(
      ({ fallback }) => useUrlState("brid", fallback, { ...stringUrlCodec }),
      { initialProps: { fallback: "" } },
    );

    rerender({ fallback: "recipe-1" });
    expect(result.current[0]).toBe("recipe-1");

    act(() => result.current[1]("recipe-2"));
    rerender({ fallback: "recipe-3" });
    expect(result.current[0]).toBe("recipe-2");
  });
});
