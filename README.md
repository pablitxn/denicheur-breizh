# dénicheur·breizh

Vite + React + TypeScript MVP for the real-estate decision workspace.

## Local

```bash
npm install
cp .env.example .env
# add OPENAI_API_KEY to .env for the Realtime voice tab
npm run dev
```

The app uses the in-repo mock API by default. Set `VITE_API_BASE_URL` when a backend is available; API calls are isolated in `src/api/denicheurApi.ts`.

## Realtime Spanish-to-French voice agent

The `Voix` / `Voz` tab starts a minimal WebRTC voice translator with `gpt-realtime-2`.

- Browser audio uses `RTCPeerConnection`: microphone input is added as a local audio track and model audio plays through a remote audio element.
- The app opens an `oai-events` data channel and sends `session.update` to configure a Spanish-to-French interpreter prompt.
- The local server endpoint is `POST /api/realtime/session`. It accepts the browser SDP offer as `application/sdp`, then posts to `https://api.openai.com/v1/realtime/calls` with multipart `FormData` fields named `sdp` and `session`.
- `OPENAI_API_KEY` is only read server-side by the Vite middleware.

## Checks

```bash
npm run typecheck
npm run test:run
npm run build
```

## Structure

- `src/api/`: typed API boundary, query keys, React Query hooks.
- `src/assets/`: typed mock data that mirrors the expected backend resources.
- `src/components/`: reusable shell and UI primitives.
- `src/features/`: MVP views for map, property list, scoring catalog, and builder.
- `src/state/`: local UI state with Zustand.
