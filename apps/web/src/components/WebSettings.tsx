import { ApplicationSettings, Button, Chip, SettingsRow } from "@denicheur-breizh/design-system";
import { LOCALE_METADATA, SETTINGS_LABELS, SUPPORTED_LOCALES } from "@denicheur-breizh/i18n";
import { RefreshCw } from "lucide-react";
import { useHealth } from "../api/hooks";
import { API_BASE_URL } from "../config/apiBaseUrl";
import { useAppIntl } from "../intl/IntlContext";
import { useWorkspaceStore } from "../state/workspaceStore";

const locales = SUPPORTED_LOCALES.map((value) => ({ value, label: LOCALE_METADATA[value].nativeName }));

export function WebSettings() {
  const { locale, setLocale } = useAppIntl();
  const theme = useWorkspaceStore((state) => state.theme);
  const setTheme = useWorkspaceStore((state) => state.setTheme);
  return (
    <ApplicationSettings
      compact
      labels={SETTINGS_LABELS[locale]}
      locale={locale}
      locales={locales}
      onLocaleChange={setLocale}
      theme={theme}
      onThemeChange={setTheme}
      development={<WebDiagnostics />}
    />
  );
}

function WebDiagnostics() {
  const { locale, t } = useAppIntl();
  const labels = SETTINGS_LABELS[locale];
  const health = useHealth();
  const connected = !health.isError && health.data?.status === "ok";
  const data = health.isError ? undefined : health.data;
  const availability = (available: boolean | undefined) => <Chip tone={available === undefined ? "default" : available ? "good" : "danger"}>{available === undefined ? labels.unknown : available ? labels.available : labels.unavailable}</Chip>;
  return <>
    <div role="status" aria-live="polite">
      <SettingsRow label={labels.api} description={API_BASE_URL}><Chip tone={health.isLoading ? "default" : connected ? "good" : "danger"}>{health.isLoading ? t("shell.apiChecking") : connected ? t("shell.liveApi") : data ? labels.degraded : t("shell.apiOffline")}</Chip></SettingsRow>
      <SettingsRow label={labels.database}>{availability(data ? data.database === "ok" : undefined)}</SettingsRow>
      <SettingsRow label={labels.media}>{data?.media.status === "disabled" ? <Chip>{labels.notConfigured}</Chip> : availability(data ? data.media.status === "ok" : undefined)}</SettingsRow>
      <SettingsRow label={labels.ai}><Chip tone={data?.openAiConfigured ? "good" : "default"}>{data ? data.openAiConfigured ? labels.configured : labels.notConfigured : labels.unknown}</Chip></SettingsRow>
    </div>
    <div className="settings-diagnostics-actions"><Button disabled={health.isFetching} onClick={() => void health.refetch()}><RefreshCw size={16} aria-hidden="true" />{labels.refresh}</Button></div>
  </>;
}
