import "@denicheur-breizh/design-system/styles.css";
import "../../src/ui/extension.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ExtensionI18nProvider } from "../../src/i18n";
import { PopupApp } from "../../src/ui/PopupApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ExtensionI18nProvider surface="popup">
      <PopupApp />
    </ExtensionI18nProvider>
  </StrictMode>,
);
