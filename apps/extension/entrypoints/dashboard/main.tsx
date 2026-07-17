import "@denicheur-breizh/design-system/styles.css";
import "../../src/ui/extension.css";
import { LOCALE_METADATA } from "@denicheur-breizh/i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ExtensionI18nProvider, loadExtensionLocale } from "../../src/i18n";
import { DashboardApp } from "../../src/ui/DashboardApp";
import { RootReady } from "../../src/ui/RootReady";
import { applyThemePreference, loadThemePreference } from "../../src/ui/theme";

async function bootstrap() {
  const [initialLocale, initialThemePreference] = await Promise.all([
    loadExtensionLocale(),
    loadThemePreference(),
  ]);
  document.documentElement.lang = LOCALE_METADATA[initialLocale].bcp47;
  applyThemePreference(initialThemePreference);

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <RootReady>
        <ExtensionI18nProvider surface="dashboard" initialLocale={initialLocale}>
          <DashboardApp initialThemePreference={initialThemePreference} />
        </ExtensionI18nProvider>
      </RootReady>
    </StrictMode>,
  );
}

void bootstrap();
