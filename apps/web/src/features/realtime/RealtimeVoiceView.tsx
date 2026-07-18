import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { formatDateTime, type MessageValues } from "@denicheur-breizh/i18n";
import { Activity, Languages, Mic, MicOff, Phone, PhoneOff, Send } from "lucide-react";
import { Button, Chip } from "@denicheur-breizh/design-system";
import { API_BASE_URL } from "../../api/denicheurApi";
import { useAppIntl } from "../../intl/IntlContext";
import type { MessageId } from "../../intl/messages";
import styles from "./RealtimeVoiceView.module.css";

export const realtimeSessionEndpoint = `${API_BASE_URL}/v1/realtime/session`;
const realtimeModel = "gpt-realtime-2";

type ConnectionStatus = "idle" | "connecting" | "connected" | "error";
type ChipTone = "default" | "good" | "danger" | "sunset";

interface RealtimeServerEvent {
  type?: string;
  delta?: string;
  text?: string;
  transcript?: string;
  error?: {
    message?: string;
  };
}

interface TranscriptUpdate {
  channel: "source" | "translation";
  text: string;
  replace: boolean;
}

interface LocalizedMessage {
  id: MessageId;
  values?: MessageValues;
}

interface RealtimeLogEntry extends LocalizedMessage {
  timestamp: Date;
}

class RealtimeUiError extends Error {
  readonly localized: LocalizedMessage;

  constructor(localized: LocalizedMessage) {
    super(localized.id);
    this.name = "RealtimeUiError";
    this.localized = localized;
  }
}

const sampleSpanishPhrases = [
  "Hola, quiero visitar una casa mañana por la tarde.",
  "Necesito comparar esta propiedad con otras del barrio.",
  "Podemos hablar el jueves a las diez de la mañana.",
];

export function buildSessionUpdateEvent() {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions:
        "You are a live Spanish-to-French interpreter. Translate every Spanish user utterance into natural French. Do not answer the request, explain, or add commentary; only provide the French translation.",
    },
  };
}

function getEventMessage(event: RealtimeServerEvent): LocalizedMessage {
  if (event.type === "error") {
    return {
      id: "realtime.event.serverError",
      values: { detail: event.error?.message ?? "unknown" },
    };
  }

  return { id: "realtime.event.server", values: { type: event.type ?? "event" } };
}

export function getTranscriptUpdate(event: RealtimeServerEvent): TranscriptUpdate | undefined {
  const type = event.type ?? "";
  if (type.includes("input_audio_transcription") && event.transcript) {
    return { channel: "source", text: event.transcript, replace: true };
  }

  if (type.includes("audio_transcript") || type.includes("output_text")) {
    const text = event.delta ?? event.transcript ?? event.text;
    if (!text) return undefined;
    return { channel: "translation", text, replace: type.endsWith(".done") };
  }

  return undefined;
}

export function RealtimeVoiceView() {
  const { locale, t } = useAppIntl();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const connectionAttemptRef = useRef(0);
  const sessionRequestRef = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [error, setError] = useState<LocalizedMessage | null>(null);
  const [events, setEvents] = useState<RealtimeLogEntry[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [prompt, setPrompt] = useState("Hola, quiero visitar una casa mañana por la tarde.");
  const [sourceTranscript, setSourceTranscript] = useState("");
  const [translatedTranscript, setTranslatedTranscript] = useState("");

  const statusTone = useMemo<ChipTone>(() => {
    if (status === "connected") return "good";
    if (status === "connecting") return "sunset";
    if (status === "error") return "danger";
    return "default";
  }, [status]);

  const pushEvent = useCallback((message: LocalizedMessage) => {
    setEvents((current) => [
      { ...message, timestamp: new Date() },
      ...current,
    ].slice(0, 10));
  }, []);

  const closeConnection = useCallback(() => {
    connectionAttemptRef.current += 1;
    sessionRequestRef.current?.abort();
    sessionRequestRef.current = null;
    dataChannelRef.current?.close();
    dataChannelRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;

    if (audioRef.current) {
      audioRef.current.srcObject = null;
    }

    setIsMuted(false);
  }, []);

  const sendRealtimeEvent = useCallback(
    (event: object) => {
      const dataChannel = dataChannelRef.current;
      if (!dataChannel || dataChannel.readyState !== "open") {
        setError({ id: "realtime.error.dataChannel" });
        return false;
      }

      dataChannel.send(JSON.stringify(event));
      pushEvent({
        id: "realtime.event.client",
        values: { type: (event as { type?: string }).type ?? "event" },
      });
      return true;
    },
    [pushEvent],
  );

  const handleServerEvent = useCallback(
    (event: RealtimeServerEvent) => {
      const transcriptUpdate = getTranscriptUpdate(event);
      if (transcriptUpdate) {
        const updateTranscript = (current: string) => transcriptUpdate.replace ? transcriptUpdate.text : `${current}${transcriptUpdate.text}`;
        if (transcriptUpdate.channel === "source") setSourceTranscript(updateTranscript);
        else setTranslatedTranscript(updateTranscript);
      }
      pushEvent(getEventMessage(event));
    },
    [pushEvent],
  );

  const connect = useCallback(async () => {
    closeConnection();
    const attempt = connectionAttemptRef.current;
    const isCurrentAttempt = () => connectionAttemptRef.current === attempt;
    setStatus("connecting");
    setError(null);
    setEvents([]);
    setSourceTranscript("");
    setTranslatedTranscript("");

    try {
      const peerConnection = new RTCPeerConnection();
      peerRef.current = peerConnection;

      peerConnection.ontrack = (event) => {
        if (isCurrentAttempt() && audioRef.current) {
          audioRef.current.srcObject = event.streams[0];
        }
      };

      peerConnection.addEventListener("connectionstatechange", () => {
        if (!isCurrentAttempt()) return;
        pushEvent({ id: "realtime.event.peer", values: { state: peerConnection.connectionState } });
        if (peerConnection.connectionState === "failed") {
          closeConnection();
          setStatus("error");
          setError({ id: "realtime.error.peer" });
        } else if (peerConnection.connectionState === "closed" || peerConnection.connectionState === "disconnected") {
          setStatus("idle");
        }
      });

      const dataChannel = peerConnection.createDataChannel("oai-events");
      dataChannelRef.current = dataChannel;
      dataChannel.addEventListener("open", () => {
        if (!isCurrentAttempt()) return;
        sendRealtimeEvent(buildSessionUpdateEvent());
        setStatus("connected");
        pushEvent({ id: "realtime.event.connected" });
      });
      dataChannel.addEventListener("close", () => {
        if (isCurrentAttempt()) setStatus("idle");
      });
      dataChannel.addEventListener("message", (message) => {
        if (!isCurrentAttempt()) return;
        try {
          handleServerEvent(JSON.parse(message.data) as RealtimeServerEvent);
        } catch {
          pushEvent({ id: "realtime.event.malformed" });
        }
      });

      const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!isCurrentAttempt()) {
        localStream.getTracks().forEach((track) => track.stop());
        peerConnection.close();
        return;
      }
      localStreamRef.current = localStream;
      localStream.getAudioTracks().forEach((track) => {
        peerConnection.addTrack(track, localStream);
      });

      const offer = await peerConnection.createOffer();
      if (!isCurrentAttempt()) return;
      await peerConnection.setLocalDescription(offer);
      if (!isCurrentAttempt()) return;

      if (!offer.sdp) {
        throw new RealtimeUiError({ id: "realtime.error.sdp" });
      }

      const sessionRequest = new AbortController();
      sessionRequestRef.current = sessionRequest;
      const sdpResponse = await fetch(realtimeSessionEndpoint, {
        method: "POST",
        body: offer.sdp,
        signal: sessionRequest.signal,
        headers: {
          "Content-Type": "application/sdp",
        },
      });

      const answerSdp = await sdpResponse.text();
      if (!isCurrentAttempt()) return;
      sessionRequestRef.current = null;
      if (!sdpResponse.ok) {
        throw new RealtimeUiError(
          answerSdp
            ? { id: "realtime.error.endpointDetail", values: { detail: answerSdp } }
            : { id: "realtime.error.endpoint" },
        );
      }

      await peerConnection.setRemoteDescription({
        type: "answer",
        sdp: answerSdp,
      });
    } catch (connectError) {
      if (!isCurrentAttempt()) return;
      closeConnection();
      setStatus("error");
      if (connectError instanceof RealtimeUiError) {
        setError(connectError.localized);
      } else if (connectError instanceof Error) {
        setError({ id: "realtime.error.connectionDetail", values: { detail: connectError.message } });
      } else {
        setError({ id: "realtime.error.connection" });
      }
    }
  }, [closeConnection, handleServerEvent, pushEvent, sendRealtimeEvent]);

  const disconnect = useCallback(() => {
    closeConnection();
    setStatus("idle");
    pushEvent({ id: "realtime.event.disconnected" });
  }, [closeConnection, pushEvent]);

  const toggleMute = useCallback(() => {
    const nextMuted = !isMuted;
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setIsMuted(nextMuted);
  }, [isMuted]);

  const submitPrompt = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const text = prompt.trim();
      if (!text) return;

      const created = sendRealtimeEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text,
            },
          ],
        },
      });

      if (created) {
        setSourceTranscript(text);
        setTranslatedTranscript("");
        sendRealtimeEvent({ type: "response.create" });
        setPrompt("");
      }
    },
    [prompt, sendRealtimeEvent],
  );

  useEffect(() => closeConnection, [closeConnection]);

  return (
    <section className={styles.workspace} aria-label={t("realtime.workspaceAria")}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>{t("realtime.eyebrow")}</span>
          <h1>{t("realtime.title")}</h1>
        </div>
        <div className={styles.headerMeta}>
          <div aria-live="polite">
            <Chip tone={statusTone} active={status !== "idle"}>
              <span className={styles.statusDot} aria-hidden="true" />
              {t(`realtime.status.${status}`)}
            </Chip>
          </div>
          <span>{realtimeModel}</span>
        </div>
      </header>

      <div className={styles.grid}>
        <section className={styles.panel} aria-label={t("realtime.sessionAria")}>
          <div className={styles.panelHeader}>
            <div>
              <span className={styles.eyebrow}>{t("realtime.session.eyebrow")}</span>
              <h2>{t("realtime.session.title")}</h2>
            </div>
            <Activity size={18} aria-hidden="true" />
          </div>

          <dl className={styles.facts}>
            <div>
              <dt>{t("realtime.session.endpoint")}</dt>
              <dd>{realtimeSessionEndpoint}</dd>
            </div>
            <div>
              <dt>{t("realtime.session.channel")}</dt>
              <dd>oai-events</dd>
            </div>
            <div>
              <dt>{t("realtime.session.audio")}</dt>
              <dd>{t("realtime.session.audioValue")}</dd>
            </div>
          </dl>

          <audio ref={audioRef} autoPlay controls className={styles.remoteAudio} aria-label={t("realtime.session.remoteAudio")} />

          <div className={styles.controls}>
            <Button variant="primary" onClick={connect} disabled={status === "connecting" || status === "connected"}>
              <Phone size={16} />
              {t("realtime.action.connect")}
            </Button>
            <Button onClick={toggleMute} disabled={status !== "connected"}>
              {isMuted ? <MicOff size={16} /> : <Mic size={16} />}
              {isMuted ? t("realtime.action.muted") : t("realtime.action.micOn")}
            </Button>
            <Button variant="ghost" onClick={disconnect} disabled={status === "idle"}>
              <PhoneOff size={16} />
              {t(status === "connecting" ? "realtime.action.cancel" : "realtime.action.disconnect")}
            </Button>
          </div>

          {error && <p className={styles.error} role="alert">{t(error.id, error.values)}</p>}
        </section>

        <section className={styles.panel} aria-label={t("realtime.translationAria")}>
          <div className={styles.panelHeader}>
            <div>
              <span className={styles.eyebrow}>{t("realtime.translation.eyebrow")}</span>
              <h2>{t("realtime.translation.title")}</h2>
            </div>
            <Languages size={18} aria-hidden="true" />
          </div>

          <div className={styles.toolSchema}>
            <span>{t("realtime.translation.input")}</span>
            <span>{t("realtime.translation.inputValue")}</span>
            <span>{t("realtime.translation.output")}</span>
            <span>{t("realtime.translation.outputValue")}</span>
          </div>

          <div className={styles.transcript} role="region" aria-live="polite" aria-label={t("realtime.transcriptAria")}>
            <div>
              <span>{t("realtime.transcript.source")}</span>
              <p>{sourceTranscript || t("realtime.transcript.empty")}</p>
            </div>
            <div>
              <span>{t("realtime.transcript.translation")}</span>
              <p>{translatedTranscript || t("realtime.transcript.empty")}</p>
            </div>
          </div>

          <div className={styles.slots} aria-label={t("realtime.samplesAria")}>
            {sampleSpanishPhrases.map((phrase) => (
              <span key={phrase}>{phrase}</span>
            ))}
          </div>

          <form className={styles.promptForm} onSubmit={submitPrompt}>
            <input
              value={prompt}
              name="realtime-prompt"
              autoComplete="off"
              onChange={(event) => setPrompt(event.target.value)}
              disabled={status !== "connected"}
              aria-label={t("realtime.promptAria")}
            />
            <Button type="submit" variant="primary" iconOnly disabled={status !== "connected" || !prompt.trim()} aria-label={t("realtime.sendAria")}>
              <Send size={16} />
            </Button>
          </form>
        </section>

        <section className={[styles.panel, styles.eventsPanel].join(" ")} aria-label={t("realtime.eventsAria")}>
          <div className={styles.panelHeader}>
            <div>
              <span className={styles.eyebrow}>{t("realtime.events.eyebrow")}</span>
              <h2>{t("realtime.events.title")}</h2>
            </div>
          </div>
          <ol className={styles.eventLog} aria-live="polite">
            {events.length === 0 ? (
              <li>{t("realtime.events.empty")}</li>
            ) : events.map((event, index) => (
              <li key={`${event.timestamp.getTime()}-${index}`}>
                {formatDateTime(event.timestamp, locale, { timeStyle: "medium" })} {t(event.id, event.values)}
              </li>
            ))}
          </ol>
        </section>
      </div>
    </section>
  );
}
