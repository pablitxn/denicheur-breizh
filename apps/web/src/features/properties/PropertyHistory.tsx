import { useId, useState } from "react";
import type { SourceRecord, SourceRecordsPage } from "@denicheur-breizh/contracts";
import { Button } from "@denicheur-breizh/design-system";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useSourceRecord, useSourceRecords } from "../../api/hooks";
import { useAppIntl } from "../../intl/IntlContext";
import { bcp47Locales, type LocaleCode } from "../../intl/locales";
import styles from "./PropertyHistory.module.css";

interface PropertyHistoryProps {
  source: string;
  externalId: string;
}

type CaptureSummary = SourceRecordsPage["items"][number];

const kindMessages = {
  "extension-search-result": "propertyHistory.searchResult",
  "extension-detail": "propertyHistory.listingPage",
  "api-ingestion": "propertyHistory.receivedData",
  "legacy-run-snapshot": "propertyHistory.legacy",
} as const;

export function PropertyHistory({ source, externalId }: PropertyHistoryProps) {
  return <HistoryContent key={`${source}:${externalId}`} source={source} externalId={externalId} />;
}

function HistoryContent({ source, externalId }: PropertyHistoryProps) {
  const { t } = useAppIntl();
  const history = useSourceRecords(source, externalId);
  const titleId = useId();
  return (
    <section className={styles.history} aria-labelledby={titleId}>
      <header className={styles.header}>
        <h3 id={titleId}>{t("propertyHistory.title")}</h3>
        <p>{t("propertyHistory.intro")}</p>
      </header>
      {history.isPending && <p role="status" className={styles.message}>{t("propertyHistory.loading")}</p>}
      {history.isError && (
        <HistoryError message={t(history.isFetchNextPageError ? "propertyHistory.pageError" : "propertyHistory.error")}
          retry={() => { void (history.isFetchNextPageError ? history.fetchNextPage() : history.refetch()); }}
          busy={history.isFetching} />
      )}
      {history.data?.length === 0 && <p className={styles.message}>{t("propertyHistory.empty")}</p>}
      {!!history.data?.length && (
        <ol className={styles.list}>
          {history.data.map((capture) => <CaptureRow key={capture.id} capture={capture} />)}
        </ol>
      )}
      {history.hasNextPage && !history.isFetchNextPageError && (
        <Button onClick={() => { void history.fetchNextPage(); }} disabled={history.isFetchingNextPage}>
          {t(history.isFetchingNextPage ? "propertyHistory.loadingMore" : "propertyHistory.loadMore")}
        </Button>
      )}
    </section>
  );
}

function CaptureRow({ capture }: { capture: CaptureSummary }) {
  const { t, locale } = useAppIntl();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const date = formatCaptureDate(capture.observedAt, locale);
  return (
    <li className={styles.capture}>
      <button type="button" className={styles.captureButton} aria-expanded={open} aria-controls={detailsId}
        aria-label={t(open ? "propertyHistory.closeCapture" : "propertyHistory.openCapture", { date })}
        onClick={() => setOpen((current) => !current)}>
        <span className={styles.marker} aria-hidden="true" />
        <span className={styles.captureHeading}>
          <time dateTime={capture.observedAt}>{date}</time>
          <span>{t(kindMessages[capture.kind])}</span>
        </span>
        {open ? <ChevronDown size={18} aria-hidden="true" /> : <ChevronRight size={18} aria-hidden="true" />}
      </button>
      <div id={detailsId} hidden={!open}>
        {open && (
          <div className={styles.details}>
            {capture.kind === "legacy-run-snapshot" && <p className={styles.legacyNotice}>{t("propertyHistory.legacyNotice")}</p>}
            <CaptureDetail id={capture.id} />
          </div>
        )}
      </div>
    </li>
  );
}

function CaptureDetail({ id }: { id: string }) {
  const capture = useSourceRecord(id);
  const { t } = useAppIntl();
  if (capture.isPending) return <p role="status" className={styles.message}>{t("propertyHistory.detailLoading")}</p>;
  if (capture.isError) return <HistoryError message={t("propertyHistory.detailError")}
    retry={() => { void capture.refetch(); }} busy={capture.isFetching} />;
  return <CapturePreview capture={capture.data} />;
}

function CapturePreview({ capture }: { capture: SourceRecord }) {
  const { t, locale } = useAppIntl();
  const [showSource, setShowSource] = useState(false);
  const fields = captureFields(capture.payloadJson);
  const hasFields = Object.values(fields).some((value) => value !== undefined);
  return (
    <>
      {hasFields ? (
        <dl className={styles.fields}>
          {fields.title !== undefined && <div><dt>{t("propertyHistory.titleField")}</dt><dd>{fields.title}</dd></div>}
          {fields.priceEuros !== undefined && <div><dt>{t("propertyHistory.priceField")}</dt>
            <dd className={styles.price}>{new Intl.NumberFormat(bcp47Locales[locale], {
              style: "currency", currency: "EUR", maximumFractionDigits: 2,
            }).format(fields.priceEuros)}</dd></div>}
          {fields.location !== undefined && <div><dt>{t("propertyHistory.locationField")}</dt><dd>{fields.location}</dd></div>}
          {fields.description !== undefined && <div><dt>{t("propertyHistory.descriptionField")}</dt><dd>{fields.description}</dd></div>}
        </dl>
      ) : <p className={styles.message}>{t("propertyHistory.noPreview")}</p>}
      <details className={styles.sourceData} onToggle={(event) => setShowSource(event.currentTarget.open)}>
        <summary>{t("propertyHistory.sourceData")}</summary>
        {showSource && <div className={styles.sourceContent}>
          <dl className={styles.fields}>
            <div><dt>{t("propertyHistory.receivedAt")}</dt>
              <dd><time dateTime={capture.receivedAt}>{formatCaptureDate(capture.receivedAt, locale)}</time></dd></div>
          </dl>
          <a href={capture.url} target="_blank" rel="noreferrer">{t("propertyHistory.openSource")}</a>
          <pre>{capture.payloadJson}</pre>
        </div>}
      </details>
    </>
  );
}

function HistoryError({ message, retry, busy }: { message: string; retry: () => void; busy: boolean }) {
  const { t } = useAppIntl();
  return <div role="alert" className={styles.error}><p>{message}</p>
    <Button size="sm" onClick={retry} disabled={busy}>{t("common.retry")}</Button></div>;
}

function formatCaptureDate(value: string, locale: LocaleCode) {
  return new Intl.DateTimeFormat(bcp47Locales[locale], { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function captureFields(payloadJson: string): { title?: string; priceEuros?: number; location?: string; description?: string } {
  let value: unknown;
  try { value = JSON.parse(payloadJson); } catch { return {}; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const data = value as Record<string, unknown>;
  const text = (field: string) => typeof data[field] === "string" && data[field].trim() ? data[field].trim() : undefined;
  return {
    title: text("title"), location: text("location"), description: text("description"),
    priceEuros: typeof data.priceEuros === "number" && Number.isFinite(data.priceEuros) && data.priceEuros >= 0
      ? data.priceEuros : undefined,
  };
}
