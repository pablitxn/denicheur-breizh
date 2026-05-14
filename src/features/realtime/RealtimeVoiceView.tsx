import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Activity, Languages, Mic, MicOff, Phone, PhoneOff, Send } from "lucide-react";
import { Button, Chip } from "../../components/ui";
import styles from "./RealtimeVoiceView.module.css";

const realtimeSessionEndpoint = "/api/realtime/session";
const realtimeModel = "gpt-realtime-2";

type ConnectionStatus = "idle" | "connecting" | "connected" | "error";
type ChipTone = "default" | "good" | "danger" | "sunset";

interface RealtimeServerEvent {
  type?: string;
  error?: {
    message?: string;
  };
}

const sampleSpanishPhrases = [
  "Hola, quiero visitar una casa mañana por la tarde.",
  "Necesito comparar esta propiedad con otras del barrio.",
  "Podemos hablar el jueves a las diez de la mañana.",
];

function buildSessionUpdateEvent() {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions:
        "You are a live Spanish-to-French interpreter. Translate every Spanish user utterance into natural French. Do not answer the request, explain, or add commentary; only provide the French translation.",
    },
  };
}

function getEventLabel(event: RealtimeServerEvent) {
  if (event.type === "error") {
    return `server error ${event.error?.message ?? "unknown"}`;
  }

  return `server ${event.type ?? "event"}`;
}

export function RealtimeVoiceView() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [prompt, setPrompt] = useState("Hola, quiero visitar una casa mañana por la tarde.");

  const statusTone = useMemo<ChipTone>(() => {
    if (status === "connected") return "good";
    if (status === "connecting") return "sunset";
    if (status === "error") return "danger";
    return "default";
  }, [status]);

  const pushEvent = useCallback((message: string) => {
    setEvents((current) => [`${new Date().toLocaleTimeString()} ${message}`, ...current].slice(0, 10));
  }, []);

  const closeConnection = useCallback(() => {
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
        setError("Realtime data channel is not open.");
        return false;
      }

      dataChannel.send(JSON.stringify(event));
      pushEvent(`client ${(event as { type?: string }).type ?? "event"}`);
      return true;
    },
    [pushEvent],
  );

  const handleServerEvent = useCallback(
    (event: RealtimeServerEvent) => {
      pushEvent(getEventLabel(event));
    },
    [pushEvent],
  );

  const connect = useCallback(async () => {
    setStatus("connecting");
    setError(null);
    setEvents([]);
    closeConnection();

    try {
      const peerConnection = new RTCPeerConnection();
      peerRef.current = peerConnection;

      peerConnection.ontrack = (event) => {
        if (audioRef.current) {
          audioRef.current.srcObject = event.streams[0];
        }
      };

      peerConnection.addEventListener("connectionstatechange", () => {
        pushEvent(`peer ${peerConnection.connectionState}`);
        if (peerConnection.connectionState === "failed") {
          setStatus("error");
          setError("Peer connection failed.");
        }
      });

      const dataChannel = peerConnection.createDataChannel("oai-events");
      dataChannelRef.current = dataChannel;
      dataChannel.addEventListener("open", () => {
        sendRealtimeEvent(buildSessionUpdateEvent());
      });
      dataChannel.addEventListener("message", (message) => {
        try {
          handleServerEvent(JSON.parse(message.data) as RealtimeServerEvent);
        } catch {
          pushEvent("server malformed event");
        }
      });

      const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = localStream;
      localStream.getAudioTracks().forEach((track) => {
        peerConnection.addTrack(track, localStream);
      });

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      if (!offer.sdp) {
        throw new Error("Browser did not create an SDP offer.");
      }

      const sdpResponse = await fetch(realtimeSessionEndpoint, {
        method: "POST",
        body: offer.sdp,
        headers: {
          "Content-Type": "application/sdp",
        },
      });

      const answerSdp = await sdpResponse.text();
      if (!sdpResponse.ok) {
        throw new Error(answerSdp || "Realtime session endpoint failed.");
      }

      await peerConnection.setRemoteDescription({
        type: "answer",
        sdp: answerSdp,
      });

      setStatus("connected");
      pushEvent("client connected");
    } catch (connectError) {
      closeConnection();
      setStatus("error");
      setError(connectError instanceof Error ? connectError.message : "Realtime connection failed.");
    }
  }, [closeConnection, handleServerEvent, pushEvent, sendRealtimeEvent]);

  const disconnect = useCallback(() => {
    closeConnection();
    setStatus("idle");
    pushEvent("client disconnected");
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
        sendRealtimeEvent({ type: "response.create" });
        setPrompt("");
      }
    },
    [prompt, sendRealtimeEvent],
  );

  useEffect(() => closeConnection, [closeConnection]);

  return (
    <section className={styles.workspace} aria-label="Realtime voice agent">
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>Realtime WebRTC</span>
          <h1>Spanish to French</h1>
        </div>
        <div className={styles.headerMeta}>
          <Chip tone={statusTone} active={status !== "idle"}>
            <span className={styles.statusDot} />
            {status}
          </Chip>
          <span>{realtimeModel}</span>
        </div>
      </header>

      <div className={styles.grid}>
        <section className={styles.panel} aria-label="Session controls">
          <div className={styles.panelHeader}>
            <div>
              <span className={styles.eyebrow}>Session</span>
              <h2>WebRTC call</h2>
            </div>
            <Activity size={18} aria-hidden="true" />
          </div>

          <dl className={styles.facts}>
            <div>
              <dt>Endpoint</dt>
              <dd>{realtimeSessionEndpoint}</dd>
            </div>
            <div>
              <dt>Channel</dt>
              <dd>oai-events</dd>
            </div>
            <div>
              <dt>Audio</dt>
              <dd>mic input / model output</dd>
            </div>
          </dl>

          <audio ref={audioRef} autoPlay className={styles.remoteAudio}>
            <track kind="captions" />
          </audio>

          <div className={styles.controls}>
            <Button variant="primary" onClick={connect} disabled={status === "connecting" || status === "connected"}>
              <Phone size={16} />
              Connect
            </Button>
            <Button onClick={toggleMute} disabled={status !== "connected"}>
              {isMuted ? <MicOff size={16} /> : <Mic size={16} />}
              {isMuted ? "Muted" : "Mic on"}
            </Button>
            <Button variant="ghost" onClick={disconnect} disabled={status === "idle" || status === "connecting"}>
              <PhoneOff size={16} />
              Disconnect
            </Button>
          </div>

          {error && <p className={styles.error}>{error}</p>}
        </section>

        <section className={styles.panel} aria-label="Translation mode">
          <div className={styles.panelHeader}>
            <div>
              <span className={styles.eyebrow}>Translation mode</span>
              <h2>Español {"->"} français</h2>
            </div>
            <Languages size={18} aria-hidden="true" />
          </div>

          <div className={styles.toolSchema}>
            <span>input</span>
            <span>Spanish speech or text</span>
            <span>output</span>
            <span>Natural spoken French</span>
          </div>

          <div className={styles.slots} aria-label="Sample Spanish phrases">
            {sampleSpanishPhrases.map((phrase) => (
              <span key={phrase}>{phrase}</span>
            ))}
          </div>

          <form className={styles.promptForm} onSubmit={submitPrompt}>
            <input
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              disabled={status !== "connected"}
              aria-label="Text prompt"
            />
            <Button variant="primary" iconOnly disabled={status !== "connected" || !prompt.trim()} aria-label="Send prompt">
              <Send size={16} />
            </Button>
          </form>
        </section>

        <section className={[styles.panel, styles.eventsPanel].join(" ")} aria-label="Realtime events">
          <div className={styles.panelHeader}>
            <div>
              <span className={styles.eyebrow}>Events</span>
              <h2>Data channel</h2>
            </div>
          </div>
          <ol className={styles.eventLog}>
            {events.length === 0 ? <li>No events yet</li> : events.map((event) => <li key={event}>{event}</li>)}
          </ol>
        </section>
      </div>
    </section>
  );
}
