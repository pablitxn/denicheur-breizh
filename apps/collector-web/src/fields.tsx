import { Chip } from "@denicheur-breizh/design-system";
import { dataFields, type CaptureObservation, type DataField, type FieldState, type FieldStates } from "@denicheur-breizh/collector-contracts";
import { useCopy, type CopyKey } from "./copy";
import { date, StatusChip } from "./components";
import { usePreferences } from "./preferences";

const labels: Record<DataField, CopyKey> = {
  title: "title", priceEuros: "price", propertyType: "propertyType", location: "location", surfaceM2: "surface", landSurfaceM2: "landSurface",
  rooms: "roomsCount", bedrooms: "bedroomsCount", description: "description", energyClass: "energyClass", gesClass: "gesClass",
  sellerName: "sellerName", sellerType: "seller", postedAt: "postedAt", features: "features", imageUrls: "images",
};
export const fieldLabel = (field: DataField, t: (key: CopyKey) => string) => t(labels[field]);
const statuses: Record<FieldState["status"], CopyKey> = { observed: "fieldObserved", absent: "absent", not_applicable: "fieldNotApplicable", unresolved: "fieldUnresolved" };

export function FieldStatus({ status }: { status: FieldState["status"] }) {
  const t = useCopy();
  return <Chip tone={status === "unresolved" ? "danger" : "default"}>{t(statuses[status])}</Chip>;
}

export function DetailStatus({ observation }: { observation: CaptureObservation }) {
  const unresolved = observation.missingFields.length > 0 || Object.values(observation.fieldStates ?? {}).some(state => state?.status === "unresolved");
  return <StatusChip status={unresolved && observation.detailStatus !== "pending" ? "incomplete" : observation.detailStatus} />;
}

interface ObservationTimeProps { fieldObservedAt?: CaptureObservation["fieldObservedAt"]; observedAt?: string }
export function FieldTimestamp({ field, states, fieldObservedAt, observedAt }: ObservationTimeProps & { field: DataField; states: FieldStates }) {
  const t = useCopy(); const locale = usePreferences(state => state.locale);
  const at = fieldObservedAt?.[field] ?? states[field]?.observedAt ?? observedAt;
  return at ? <small className="field-observed-at">{t("observed")} <time dateTime={at}>{date(at, locale)}</time></small> : null;
}

export function FieldStateList({ states, fields, fieldObservedAt, observedAt }: ObservationTimeProps & { states: FieldStates; fields?: DataField[] }) {
  const t = useCopy();
  const visible = dataFields.filter(field => (states[field] || fieldObservedAt?.[field]) && (!fields || fields.includes(field)));
  if (!visible.length) return <p className="muted">{t("fieldStatesUnknown")}</p>;
  return <dl className="field-state-list">{visible.map(field => {
    const state = states[field];
    return <div className="field-state" key={field}><dt><strong>{fieldLabel(field, t)}</strong>{state && <FieldStatus status={state.status} />}</dt><dd><FieldTimestamp field={field} states={states} fieldObservedAt={fieldObservedAt} observedAt={observedAt} /><p className={state ? undefined : "muted"}>{state?.reason ?? t("fieldStateUnknown")}</p>{state && state.evidence.length > 0 && <details><summary>{t("evidence")} ({state.evidence.length})</summary>{state.evidence.map((evidence, index) => <blockquote key={index}><a href={evidence.url} target="_blank" rel="noreferrer">{evidence.url}</a><p>{evidence.text}</p></blockquote>)}</details>}</dd></div>;
  })}</dl>;
}
