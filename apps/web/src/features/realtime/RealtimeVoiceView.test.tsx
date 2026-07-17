import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppIntlProvider, localeStorageKey } from "../../intl/IntlContext";
import { buildSessionUpdateEvent, getTranscriptUpdate, RealtimeVoiceView } from "./RealtimeVoiceView";

function setStoredLocale(locale: string) {
  const values = new Map([[localeStorageKey, locale]]);
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
}

describe("RealtimeVoiceView localisation", () => {
  it("keeps the Spanish-to-French interpreter instruction unchanged", () => {
    expect(buildSessionUpdateEvent().session.instructions).toContain("Spanish-to-French interpreter");
    expect(buildSessionUpdateEvent().session.instructions).toContain("only provide the French translation");
  });

  it("extracts source and translated transcript updates from realtime events", () => {
    expect(getTranscriptUpdate({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Quiero visitar la casa.",
    })).toEqual({ channel: "source", text: "Quiero visitar la casa.", replace: true });
    expect(getTranscriptUpdate({ type: "response.audio_transcript.delta", delta: "Je veux " })).toEqual({
      channel: "translation",
      text: "Je veux ",
      replace: false,
    });
    expect(getTranscriptUpdate({ type: "response.audio_transcript.done", transcript: "Je veux visiter la maison." })).toEqual({
      channel: "translation",
      text: "Je veux visiter la maison.",
      replace: true,
    });
  });

  it("localises the interface while retaining Spanish sample input and translation direction", () => {
    setStoredLocale("en");
    render(
      <AppIntlProvider>
        <RealtimeVoiceView />
      </AppIntlProvider>,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Spanish to French" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Translation mode" })).toHaveTextContent("Spanish to French");
    expect(screen.getByText("Hola, quiero visitar una casa mañana por la tarde.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send text" })).toBeDisabled();
    expect(screen.getByLabelText("Translated audio output")).toHaveAttribute("controls");
    expect(screen.getByRole("region", { name: "Live transcript" })).toBeInTheDocument();
  });

  it.each([
    ["fr", "Espagnol vers français", "Contrôles de session"],
    ["es", "Español a francés", "Controles de sesión"],
  ])("renders the %s Realtime controls", (locale, title, sessionLabel) => {
    setStoredLocale(locale);
    render(
      <AppIntlProvider>
        <RealtimeVoiceView />
      </AppIntlProvider>,
    );

    expect(screen.getByRole("heading", { level: 1, name: title })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: sessionLabel })).toBeInTheDocument();
  });
});
