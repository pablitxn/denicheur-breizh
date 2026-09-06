/** A field's latest request owns both its value and its recovery/error state. */
export function updateStorageRefreshErrors<K extends string>(
  errors: Partial<Record<K, string>>,
  fields: readonly K[],
  requestVersions: Record<K, number>,
  currentVersions: Record<K, number>,
  error?: unknown,
): Partial<Record<K, string>> {
  const updated = { ...errors };
  for (const field of fields) {
    if (requestVersions[field] !== currentVersions[field]) continue;
    if (error === undefined) delete updated[field];
    else updated[field] = error instanceof Error ? error.message : String(error);
  }
  return updated;
}
