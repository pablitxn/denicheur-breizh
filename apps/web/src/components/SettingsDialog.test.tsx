import { ApplicationSettings } from "@denicheur-breizh/design-system";
import { SETTINGS_LABELS } from "@denicheur-breizh/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

describe("shared settings preference saves", () => {
  it("reports failed persistence inside the modal and allows a retry", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("Storage unavailable")).mockResolvedValue(undefined);
    render(<ApplicationSettings labels={SETTINGS_LABELS.en} locale="en" locales={[{ value: "en", label: "English" }]} onLocaleChange={() => undefined} theme="system" onThemeChange={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await act(async () => fireEvent.change(screen.getByRole("combobox", { name: "Appearance" }), { target: { value: "dark" } }));
    expect(await screen.findByRole("alert")).toHaveTextContent(SETTINGS_LABELS.en.saveFailed);
    expect(screen.getByRole("combobox", { name: "Appearance" })).toBeEnabled();
    await act(async () => fireEvent.change(screen.getByRole("combobox", { name: "Appearance" }), { target: { value: "light" } }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(save.mock.calls).toEqual([["dark"], ["light"]]);
  });

  it("does not initialize development content until requested", () => {
    const mount = vi.fn();
    function Development() { mount(); return <p>Connection tools</p>; }
    render(<ApplicationSettings labels={SETTINGS_LABELS.en} locale="en" locales={[{ value: "en", label: "English" }]} onLocaleChange={() => undefined} theme="system" onThemeChange={() => undefined} development={<Development />} />);
    expect(mount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(mount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Development" }));
    expect(screen.getByText("Connection tools")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).not.toBe("hidden");
  });
});
