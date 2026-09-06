import { KeyRound, LoaderCircle, RefreshCw, Save, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button, Chip, SectionLabel } from "@denicheur-breizh/design-system";
import {
  clearRuntimeApiConfig,
  DEFAULT_API_BASE_URL,
  loadRuntimeApiConfig,
  normalizeAllowedApiBaseUrl,
  PRODUCTION_API_BASE_URL,
  RUNTIME_API_STORAGE_KEYS,
  saveRuntimeApiConfig,
  type RuntimeApiConfig,
  type RuntimeApiConfigInput,
} from "../api/runtimeConfig";
import { useExtensionI18n } from "../i18n";

interface RuntimeApiSettingsSaveDraft {
  baseUrl: string;
  tokenDraft: string;
  currentConfig: RuntimeApiConfig;
}

export function prepareRuntimeApiSettingsSave({
  baseUrl,
  tokenDraft,
  currentConfig,
}: RuntimeApiSettingsSaveDraft): RuntimeApiConfigInput {
  const normalizedBaseUrl = normalizeAllowedApiBaseUrl(baseUrl);
  const replacementToken = tokenDraft.trim();
  if (replacementToken) {
    return { baseUrl: normalizedBaseUrl, operatorToken: replacementToken };
  }

  const currentCredential = currentConfig.credential;
  return currentCredential?.endpoint === normalizedBaseUrl
    ? { baseUrl: normalizedBaseUrl, operatorToken: currentCredential.token }
    : { baseUrl: normalizedBaseUrl };
}

export function runtimeApiCredentialAppliesToDraft(
  config: RuntimeApiConfig,
  baseUrl: string,
): boolean {
  try {
    return config.credential?.endpoint === normalizeAllowedApiBaseUrl(baseUrl);
  } catch {
    return false;
  }
}

export function RuntimeApiSettings() {
  const { t } = useExtensionI18n();
  const [baseUrl, setBaseUrl] = useState(DEFAULT_API_BASE_URL);
  const [tokenDraft, setTokenDraft] = useState("");
  const [currentConfig, setCurrentConfig] = useState<RuntimeApiConfig>({
    baseUrl: DEFAULT_API_BASE_URL,
  });
  const [pending, setPending] = useState(false);
  const [hydrationState, setHydrationState] = useState<"loading" | "ready" | "error">("loading");
  const [refreshRetry, setRefreshRetry] = useState(0);
  const [draftConflict, setDraftConflict] = useState(false);
  const [feedback, setFeedback] = useState<"saved" | "cleared">();
  const [error, setError] = useState<"invalid" | "loadFailed" | "updateFailed">();
  const dirtyRef = useRef(false);
  const pendingRef = useRef(false);
  const refreshVersionRef = useRef(0);
  const editingDisabled = pending || hydrationState !== "ready";
  const savedCredentialApplies = runtimeApiCredentialAppliesToDraft(currentConfig, baseUrl);
  const hasToken = savedCredentialApplies;

  useEffect(() => {
    let mounted = true;
    setHydrationState("loading");

    const refresh = () => {
      const requestVersion = ++refreshVersionRef.current;
      void loadRuntimeApiConfig()
        .then((config) => {
          if (!mounted || requestVersion !== refreshVersionRef.current) return;
          setCurrentConfig(config);
          if (dirtyRef.current) {
            setDraftConflict(true);
          } else {
            setBaseUrl(config.baseUrl);
            setDraftConflict(false);
          }
          setError((current) => current === "loadFailed" ? undefined : current);
          setHydrationState("ready");
        })
        .catch(() => {
          if (!mounted || requestVersion !== refreshVersionRef.current) return;
          setError("loadFailed");
          setHydrationState((current) => current === "ready" ? current : "error");
        });
    };

    refresh();
    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (pendingRef.current || areaName !== "local" || !Object.values(RUNTIME_API_STORAGE_KEYS).some((key) => key in changes)) return;
      refresh();
    };
    chrome.storage.onChanged.addListener(listener);

    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [refreshRetry]);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current || hydrationState !== "ready") return;
    let normalizedBaseUrl: string;
    try {
      normalizedBaseUrl = normalizeAllowedApiBaseUrl(baseUrl);
    } catch {
      setError("invalid");
      return;
    }
    pendingRef.current = true;
    refreshVersionRef.current += 1;
    setPending(true);
    setFeedback(undefined);
    setError(undefined);
    try {
      const current = await loadRuntimeApiConfig();
      const saved = await saveRuntimeApiConfig(prepareRuntimeApiSettingsSave({
        baseUrl: normalizedBaseUrl,
        tokenDraft,
        currentConfig: current,
      }));
      setCurrentConfig(saved);
      setBaseUrl(saved.baseUrl);
      setTokenDraft("");
      dirtyRef.current = false;
      setDraftConflict(false);
      setFeedback("saved");
    } catch {
      setError("updateFailed");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  async function handleClear() {
    if (pendingRef.current || hydrationState !== "ready") return;
    pendingRef.current = true;
    refreshVersionRef.current += 1;
    setPending(true);
    setFeedback(undefined);
    setError(undefined);
    try {
      await clearRuntimeApiConfig();
      setCurrentConfig({ baseUrl: DEFAULT_API_BASE_URL });
      setBaseUrl(DEFAULT_API_BASE_URL);
      setTokenDraft("");
      dirtyRef.current = false;
      setDraftConflict(false);
      setFeedback("cleared");
    } catch {
      setError("updateFailed");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <section className="runtime-api-surface dashboard-state" aria-labelledby="runtime-api-title" aria-busy={hydrationState === "loading" || pending}>
      <div className="surface-head">
        <div>
          <h2 id="runtime-api-title">{t("apiConfig.title")}</h2>
          <p>{t("apiConfig.description")}</p>
        </div>
        <Chip tone={hasToken ? "good" : "sunset"}>
          <KeyRound size={13} />
          {t(hasToken ? "apiConfig.tokenConfigured" : "apiConfig.tokenMissing")}
        </Chip>
      </div>

      <form className="runtime-api-form" onSubmit={handleSave}>
        <label className="field runtime-api-url-field">
          <SectionLabel>{t("apiConfig.baseUrl")}</SectionLabel>
          <input
            className="input"
            name="runtime-api-base-url"
            type="url"
            required
            disabled={editingDisabled}
            spellCheck={false}
            autoComplete="off"
            list="runtime-api-base-url-options"
            value={baseUrl}
            onChange={(event) => {
              dirtyRef.current = true;
              setBaseUrl(event.target.value);
              setTokenDraft("");
              setFeedback(undefined);
              setError(undefined);
            }}
          />
          <datalist id="runtime-api-base-url-options">
            <option value={DEFAULT_API_BASE_URL} />
            <option value={PRODUCTION_API_BASE_URL} />
          </datalist>
          <small>{t("apiConfig.baseUrlHelp")}</small>
        </label>

        <label className="field runtime-api-token-field">
          <SectionLabel>{t("apiConfig.operatorToken")}</SectionLabel>
          <input
            className="input"
            name="runtime-api-operator-token"
            type="password"
            disabled={editingDisabled}
            spellCheck={false}
            autoComplete="new-password"
            value={tokenDraft}
            placeholder={t(savedCredentialApplies
              ? "apiConfig.tokenPlaceholderConfigured"
              : "apiConfig.tokenPlaceholderEmpty")}
            onChange={(event) => {
              dirtyRef.current = true;
              setTokenDraft(event.target.value);
              setFeedback(undefined);
              setError(undefined);
            }}
          />
          <small>{t("apiConfig.tokenHelp")}</small>
        </label>

        <div className="runtime-api-actions">
          <Button type="submit" size="sm" disabled={editingDisabled}>
            <Save size={14} />
            {t(pending ? "apiConfig.saving" : "apiConfig.save")}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={editingDisabled} onClick={handleClear}>
            <Trash2 size={14} />
            {t("apiConfig.clear")}
          </Button>
        </div>
      </form>

      <div className="runtime-api-feedback" aria-live="polite">
        {hydrationState === "loading" && <span role="status"><LoaderCircle className="spin" size={14} /> {t("apiConfig.loading")}</span>}
        {error && <span className="field-error" role="alert">{t(`apiConfig.${error}`)}</span>}
        {error === "loadFailed" && (
          <Button type="button" size="sm" variant="ghost" disabled={pending || hydrationState === "loading"} onClick={() => setRefreshRetry((current) => current + 1)}>
            <RefreshCw size={14} />
            {t("action.retry")}
          </Button>
        )}
        {draftConflict && <span role="status">{t("apiConfig.draftConflict")}</span>}
        {!error && feedback === "saved" && <span>{t("apiConfig.saved")}</span>}
        {!error && feedback === "cleared" && <span>{t("apiConfig.cleared")}</span>}
      </div>
    </section>
  );
}
