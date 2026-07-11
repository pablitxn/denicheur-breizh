import "@denicheur-breizh/design-system/styles.css";
import "../../src/ui/extension.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DashboardApp } from "../../src/ui/DashboardApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DashboardApp />
  </StrictMode>,
);
