export const features = {
  realtimeVoice: import.meta.env.VITE_ENABLE_REALTIME === "true",
} as const;
