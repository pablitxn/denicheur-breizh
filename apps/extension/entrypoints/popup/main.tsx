import "@denicheur-breizh/design-system/styles.css";
import "../../src/ui/extension.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PopupApp } from "../../src/ui/PopupApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PopupApp />
  </StrictMode>,
);
