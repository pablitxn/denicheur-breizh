import { Chip, Button } from "@denicheur-breizh/design-system";
import type { ProviderBudget } from "@denicheur-breizh/collector-contracts";
import { AlertCircle, ChevronLeft, ChevronRight } from "lucide-react";
import { isCopyKey, useCopy } from "./copy";
import { usePreferences } from "./preferences";

export function ErrorNotice({ error }: { error: Error | null }) {
  if (!error) return null;
  return <p className="error-notice" role="alert"><AlertCircle size={17} aria-hidden /><span>{error.message}</span></p>;
}
export function StatusChip({ status, coverage = false }: { status: string; coverage?: boolean }) {
  const t = useCopy();
  const key = ({ verified_complete: "complete", unknown: "unverified", partial: "incomplete", technical_limitation: "blocked", captured: "done", pending: "queued" } as Record<string, string>)[status] ?? status;
  const tone = key === "complete" ? "good" : ["blocked", "failed", "interrupted"].includes(key) ? "danger" : ["running", "queued"].includes(key) ? "sea" : "default";
  return <Chip tone={tone} title={coverage ? t("coverageHelp") : undefined}>{isCopyKey(key) ? t(key) : t("unknown")}</Chip>;
}
export function BudgetDisplay({ budget }: { budget: ProviderBudget }) {
  const t = useCopy(); const locale = usePreferences((state) => state.locale);
  const amount = (value: number) => new Intl.NumberFormat(locale, budget.unit === "usd" ? { style: "currency", currency: "USD", maximumFractionDigits: 3 } : { maximumFractionDigits: 1 }).format(value);
  return <div className="budget"><span>{t("budget")}</span><strong>{amount(budget.spent)} <span>/ {amount(budget.limit)} {budget.unit === "credits" ? t("credits") : ""}</span></strong><small>{t("confirmedCost")}{(budget.estimated ?? 0) > 0 && <> · {t("estimatedCost")}: {amount(budget.estimated ?? 0)}</>}</small><progress value={Math.min(budget.spent + (budget.estimated ?? 0), budget.limit)} max={budget.limit || 1} aria-label={t("budget")} /><small>{t("spent")}{budget.unknownCalls > 0 ? ` · ${t("unknownConsumption")}` : ""}</small></div>;
}
export function Pagination({ offset, limit, total, onChange }: { offset: number; limit: number; total: number; onChange: (offset: number) => void }) {
  const t = useCopy();
  if (total <= limit) return null;
  return <div className="pagination"><span>{Math.min(offset + 1, total)}–{Math.min(offset + limit, total)} / {total}</span><Button size="sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}><ChevronLeft size={16} aria-hidden />{t("previous")}</Button><Button size="sm" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>{t("next")}<ChevronRight size={16} aria-hidden /></Button></div>;
}
export function money(value: number | null | undefined, locale: string, currency = "EUR") { return value == null ? "—" : new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: currency === "USD" ? 4 : 0 }).format(value); }
export function date(value: string, locale: string) { return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }
