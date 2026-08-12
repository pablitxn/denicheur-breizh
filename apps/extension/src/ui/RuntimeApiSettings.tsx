import { KeyRound, Save, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
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
  const [feedback, setFeedback] = useState<"saved" | "cleared">();
  const [error, setError] = useState(false);
  const savedCredentialApplies = runtimeApiCredentialAppliesToDraft(currentConfig, baseUrl);
  const hasToken = savedCredentialApplies;

  useEffect(() => {
    let mounted = true;

    const refresh = () => {
      void loadRuntimeApiConfig()
        .then((config) => {
          if (!mounted) return;
          setCurrentConfig(config);
          setBaseUrl(config.baseUrl);
          setTokenDraft("");
          setError(false);
        })
        .catch(() => {
          if (mounted) setError(true);
        });
    };

    refresh();
    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== "local" || !Object.values(RUNTIME_API_STORAGE_KEYS).some((key) => key in changes)) return;
      refresh();
    };
    chrome.storage.onChanged.addListener(listener);

    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setFeedback(undefined);
    setError(false);
    try {
      const current = await loadRuntimeApiConfig();
      const saved = await saveRuntimeApiConfig(prepareRuntimeApiSettingsSave({
        baseUrl,
        tokenDraft,
        currentConfig: current,
      }));
      setCurrentConfig(saved);
      setBaseUrl(saved.baseUrl);
      setTokenDraft("");
      setFeedback("saved");
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }

  async function handleClear() {
    setPending(true);
    setFeedback(undefined);
    setError(false);
    try {
      await clearRuntimeApiConfig();
      setCurrentConfig({ baseUrl: DEFAULT_API_BASE_URL });
      setBaseUrl(DEFAULT_API_BASE_URL);
      setTokenDraft("");
      setFeedback("cleared");
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="runtime-api-surface dashboard-state" aria-labelledby="runtime-api-title">
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
            spellCheck={false}
            autoComplete="off"
            list="runtime-api-base-url-options"
            value={baseUrl}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              setTokenDraft("");
              setFeedback(undefined);
              setError(false);
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
            spellCheck={false}
            autoComplete="new-password"
            value={tokenDraft}
            placeholder={t(savedCredentialApplies
              ? "apiConfig.tokenPlaceholderConfigured"
              : "apiConfig.tokenPlaceholderEmpty")}
            onChange={(event) => {
              setTokenDraft(event.target.value);
              setFeedback(undefined);
              setError(false);
            }}
          />
          <small>{t("apiConfig.tokenHelp")}</small>
        </label>

        <div className="runtime-api-actions">
          <Button type="submit" size="sm" disabled={pending}>
            <Save size={14} />
            {t(pending ? "apiConfig.saving" : "apiConfig.save")}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={handleClear}>
            <Trash2 size={14} />
            {t("apiConfig.clear")}
          </Button>
        </div>
      </form>

      <div className="runtime-api-feedback" aria-live="polite">
        {error && <span className="field-error">{t("apiConfig.invalid")}</span>}
        {!error && feedback === "saved" && <span>{t("apiConfig.saved")}</span>}
        {!error && feedback === "cleared" && <span>{t("apiConfig.cleared")}</span>}
      </div>
    </section>
  );
}
