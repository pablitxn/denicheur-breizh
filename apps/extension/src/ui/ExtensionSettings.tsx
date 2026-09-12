import { ApplicationSettings } from "@denicheur-breizh/design-system";
import { LOCALE_METADATA, SETTINGS_LABELS, SUPPORTED_LOCALES } from "@denicheur-breizh/i18n";
import { useExtensionI18n } from "../i18n";
import { RuntimeApiSettings } from "./RuntimeApiSettings";
import { useThemePreference, type ThemePreference } from "./theme";

const locales = SUPPORTED_LOCALES.map((value) => ({ value, label: LOCALE_METADATA[value].nativeName }));

export function ExtensionSettings({ initialThemePreference = "system", compact = false }: { initialThemePreference?: ThemePreference; compact?: boolean }) {
  const { locale, setLocale } = useExtensionI18n();
  const { preference, setPreference } = useThemePreference(initialThemePreference);
  return (
    <ApplicationSettings
      labels={SETTINGS_LABELS[locale]}
      locale={locale}
      locales={locales}
      onLocaleChange={setLocale}
      theme={preference}
      onThemeChange={setPreference}
      compact={compact}
      development={<RuntimeApiSettings />}
    />
  );
}
