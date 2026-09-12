import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@denicheur-breizh/design-system/styles.css";
import "./styles.css";
import { App } from "./App";

const client = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 1000, refetchOnWindowFocus: true }, mutations: { retry: false } } });
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><QueryClientProvider client={client}><App /></QueryClientProvider></React.StrictMode>);
