import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { commitWorkspaceHref, workspaceSearchHref, workspaceUrlChangeEvent } from "./workspaceNavigation";

interface UrlStateCodec<T> {
  parse: (value: string | null) => T | undefined;
  serialize: (value: T) => string | null;
}

interface UrlStateOptions<T> extends UrlStateCodec<T> {
  history?: "push" | "replace";
  isDefault?: (value: T) => boolean;
}

function readValue<T>(key: string, fallback: T, parse: UrlStateCodec<T>["parse"]): T {
  if (typeof window === "undefined") return fallback;
  return parse(new URLSearchParams(window.location.search).get(key)) ?? fallback;
}

/**
 * Keeps shareable workspace controls in the URL without requiring a routing library.
 * Updates use replaceState by default so sliders and text inputs do not flood browser history.
 */
export function useUrlState<T>(
  key: string,
  fallback: T,
  options: UrlStateOptions<T>,
): [T, Dispatch<SetStateAction<T>>] {
  const { history = "replace", isDefault, parse, serialize } = options;
  const [value, setValue] = useState<T>(() => readValue(key, fallback, parse));
  const valueRef = useRef(value);
  const fallbackRef = useRef(fallback);
  const parseRef = useRef(parse);

  valueRef.current = value;
  fallbackRef.current = fallback;
  parseRef.current = parse;

  useEffect(() => {
    const syncFromLocation = () => {
      const next = readValue(key, fallbackRef.current, parseRef.current);
      valueRef.current = next;
      setValue(next);
    };
    window.addEventListener("popstate", syncFromLocation);
    window.addEventListener(workspaceUrlChangeEvent, syncFromLocation);
    return () => {
      window.removeEventListener("popstate", syncFromLocation);
      window.removeEventListener(workspaceUrlChangeEvent, syncFromLocation);
    };
  }, [key]);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has(key)) return;
    if (serialize(valueRef.current) === serialize(fallback)) return;

    valueRef.current = fallback;
    setValue(fallback);
  }, [fallback, key, serialize]);

  const updateValue = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      const resolved = typeof next === "function" ? (next as (previous: T) => T)(valueRef.current) : next;
      valueRef.current = resolved;
      setValue(resolved);
      const encoded = isDefault?.(resolved) ? null : serialize(resolved);
      commitWorkspaceHref(workspaceSearchHref({ [key]: encoded }), history);
    },
    [history, isDefault, key, serialize],
  );

  return [value, updateValue];
}

export const stringUrlCodec: UrlStateCodec<string> = {
  parse: (value) => value ?? undefined,
  serialize: (value) => value || null,
};

export const numberUrlCodec: UrlStateCodec<number> = {
  parse: (value) => {
    if (value === null || value.trim() === "") return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  },
  serialize: (value) => (Number.isFinite(value) ? String(value) : null),
};

export const booleanUrlCodec: UrlStateCodec<boolean> = {
  parse: (value) => (value === "1" ? true : value === "0" ? false : undefined),
  serialize: (value) => (value ? "1" : "0"),
};

export function enumUrlCodec<const T extends string>(allowed: readonly T[]): UrlStateCodec<T> {
  const values = new Set<string>(allowed);
  return {
    parse: (value) => (value && values.has(value) ? (value as T) : undefined),
    serialize: (value) => value,
  };
}

export function stringArrayUrlCodec<const T extends string>(allowed?: readonly T[]): UrlStateCodec<T[]> {
  const values = allowed ? new Set<string>(allowed) : undefined;
  return {
    parse: (value) => {
      if (value === null) return undefined;
      if (value === "-") return [];
      const parsed = value
        .split(",")
        .map((item) => item.trim())
        .filter((item): item is T => Boolean(item) && (!values || values.has(item)));
      return parsed;
    },
    serialize: (value) => value.length > 0 ? value.join(",") : "-",
  };
}
