export {
  DEFAULT_LOCALE,
  EXTENSION_LOCALE_STORAGE_KEY,
  ExtensionI18nProvider,
  detectBrowserLocale,
  extensionMessage,
  loadExtensionLocale,
  resolvePreferredLocale,
  useExtensionI18n,
  type ExtensionSurface,
} from "./I18nProvider";
export { LocaleSelector } from "./LocaleSelector";
export {
  enCatalog,
  esCatalog,
  extensionCatalogs,
  frCatalog,
  isExtensionMessageId,
  translateExtension,
  type ExtensionMessageId,
  type ExtensionTranslate,
} from "./messages";
export {
  isLocalizedTextDescriptor,
  filterWarningFieldLabel,
  localeDisplayName,
  missingFieldLabel,
  resolveLocalizedText,
  translateFilterValidationIssue,
  translateLegacyText,
  type LocalizedTextDescriptor,
  type ResolvedLocalizedText,
} from "./runtime";
