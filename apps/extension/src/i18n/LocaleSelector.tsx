import { LOCALE_METADATA, SUPPORTED_LOCALES } from "@denicheur-breizh/i18n";
import { useExtensionI18n } from "./I18nProvider";

export function LocaleSelector() {
  const { locale, setLocale, t } = useExtensionI18n();

  return (
    <div className="locale-selector" role="group" aria-label={t("locale.selectorLabel")}>
      {SUPPORTED_LOCALES.map((option) => (
        <button
          key={option}
          className="locale-option"
          type="button"
          aria-pressed={locale === option}
          aria-label={t("locale.changeTo", { language: LOCALE_METADATA[option].nativeName })}
          title={LOCALE_METADATA[option].nativeName}
          onClick={() => void setLocale(option)}
        >
          {LOCALE_METADATA[option].label}
        </button>
      ))}
    </div>
  );
}
