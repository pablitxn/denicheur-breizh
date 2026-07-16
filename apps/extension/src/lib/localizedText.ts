import type { MessageDescriptor, MessageValues } from "@denicheur-breizh/i18n";

import type { LocalizedText } from "./types";

export function message(
  id: string,
  values?: MessageValues,
  technicalDetail?: string,
): MessageDescriptor<string> {
  return {
    id,
    ...(values ? { values } : {}),
    ...(technicalDetail ? { technicalDetail } : {}),
  };
}

/** Returns a safe diagnostic string for Error objects and logs, never UI copy. */
export function localizedTextDetail(value: LocalizedText): string {
  return typeof value === "string" ? value : value.technicalDetail ?? value.id;
}

export function ensureMessageDescriptor(
  value: LocalizedText,
  fallbackId = "legacy.message",
): MessageDescriptor<string> {
  return typeof value === "string"
    ? { id: fallbackId, technicalDetail: value }
    : value;
}

export function errorMessageDescriptor(id: string, error: unknown): MessageDescriptor<string> {
  return message(id, undefined, error instanceof Error ? error.message : String(error));
}
