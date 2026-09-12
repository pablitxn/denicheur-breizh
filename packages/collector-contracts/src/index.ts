import { z } from "zod";

export const providerIds = ["xai", "firecrawl"] as const;
export const providerIdSchema = z.enum(providerIds);
export type ProviderId = z.infer<typeof providerIdSchema>;
export const captureStrategyIds = ["xai-web-search-v1", "firecrawl-agent-scrape-v1", "firecrawl-agent-native-v2", "firecrawl-agent-expanded-v3", "firecrawl-detail-repair-v4", "firecrawl-native-inventory-v5", "firecrawl-gallery-audit-v6", "firecrawl-gallery-walk-v7"] as const;
export const captureStrategySchema = z.enum(captureStrategyIds);
export type CaptureStrategyId = z.infer<typeof captureStrategySchema>;
export const httpsUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
}, "A public HTTPS URL without credentials is required.");
export const searchFiltersSchema = z.object({
  category: z.enum(["sale", "rent", "shared", "commercial", "new"]).default("sale"),
  text: z.string().default(""), location: z.string().default(""),
  propertyTypes: z.array(z.enum(["house", "apartment", "land", "parking", "other"])).default(["house", "apartment"]),
  seller: z.enum(["all", "private", "professional"]).default("all"),
  priceMin: z.number().nonnegative().optional(), priceMax: z.number().nonnegative().optional(),
  surfaceMin: z.number().nonnegative().optional(), surfaceMax: z.number().nonnegative().optional(),
  roomsMin: z.number().int().nonnegative().optional(), roomsMax: z.number().int().nonnegative().optional(),
  bedroomsMin: z.number().int().nonnegative().optional(), bedroomsMax: z.number().int().nonnegative().optional(),
  sort: z.enum(["recent", "relevance"]).default("recent"),
}).strict().superRefine((value, ctx) => {
  for (const [min, max] of [["priceMin", "priceMax"], ["surfaceMin", "surfaceMax"], ["roomsMin", "roomsMax"], ["bedroomsMin", "bedroomsMax"]] as const) {
    if (value[min] !== undefined && value[max] !== undefined && value[min]! > value[max]!) ctx.addIssue({code:"custom",path:[max],message:"Maximum must not be less than minimum."});
  }
});
export type SearchFilters = z.infer<typeof searchFiltersSchema>;
export const dataFields = ["title","priceEuros","propertyType","location","surfaceM2","landSurfaceM2","rooms","bedrooms","description","energyClass","gesClass","sellerName","sellerType","postedAt","features","imageUrls"] as const;
export type DataField = typeof dataFields[number];
const repairFieldsSchema = z.array(z.enum(dataFields)).min(1);
export const repairRequestSchema = z.object({ listingIds: z.array(z.string().min(1)).min(1).optional(), fields: repairFieldsSchema.optional(), name: z.string().trim().min(1).max(200).optional() }).strict();
export type RepairRequest = z.infer<typeof repairRequestSchema>;
export const captureRepairSchema = z.object({ parentRunId: z.string().uuid(), targets: z.array(z.object({ listingId: z.string().min(1), fields: repairFieldsSchema }).strict()).min(1) }).strict();
export type CaptureRepair = z.infer<typeof captureRepairSchema>;
export const captureRequestSchema = z.object({
  provider: providerIdSchema, source: z.string().regex(/^[a-z][a-z0-9-]*$/).default("leboncoin"),
  strategy: captureStrategySchema.optional(),
  mode: z.enum(["urls", "search"]), name: z.string().trim().min(1).max(200),
  urls: z.array(httpsUrlSchema).default([]), searchUrl: httpsUrlSchema.optional(),
  filters: searchFiltersSchema.default(() => searchFiltersSchema.parse({})),
  repair: captureRepairSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.strategy && !value.strategy.startsWith(`${value.provider}-`)) ctx.addIssue({code:"custom",path:["strategy"],message:"Strategy does not belong to the selected provider."});
  if (value.mode === "urls" && !value.urls.length) ctx.addIssue({code:"custom",path:["urls"],message:"At least one listing URL is required."});
  if (value.mode === "search" && !value.searchUrl && !value.filters.location.trim() && !value.filters.text.trim()) ctx.addIssue({code:"custom",path:["filters","location"],message:"Provide a location, query or native search URL."});
  if (value.repair && value.mode !== "urls") ctx.addIssue({code:"custom",path:["repair"],message:"A repair must target known listing URLs."});
  if (value.repair && new Set(value.repair.targets.map(target => target.listingId)).size !== value.repair.targets.length) ctx.addIssue({code:"custom",path:["repair","targets"],message:"Each repair listing must occur only once."});
});
export type CaptureRequest = z.infer<typeof captureRequestSchema>;
const text = z.string().nullable().optional();
const number = z.number().finite().nonnegative().nullable().optional();
export const listingDataSchema = z.object({
  title: text, priceEuros: number, propertyType: text, location: text,
  surfaceM2: number, landSurfaceM2: number, rooms: number, bedrooms: number,
  description: text, energyClass: text, gesClass: text, sellerName: text, sellerType: text, postedAt: text,
  features: z.array(z.string()).optional(), imageUrls: z.array(httpsUrlSchema).optional(),
}).strict();
export type ListingData = z.infer<typeof listingDataSchema>;
export const evidenceSchema = z.object({url: httpsUrlSchema, text: z.string(), kind: z.enum(["page","citation","trace","manual"]).default("citation")});
export type Evidence = z.infer<typeof evidenceSchema>;
export const fieldStateSchema = z.object({ status: z.enum(["observed", "absent", "not_applicable", "unresolved"]), reason: z.string().trim().min(1), evidence: z.array(evidenceSchema), observedAt: z.string().datetime({offset:true}).optional() }).strict();
export type FieldState = z.infer<typeof fieldStateSchema>;
export const fieldStatesSchema = z.partialRecord(z.enum(dataFields), fieldStateSchema);
export type FieldStates = z.infer<typeof fieldStatesSchema>;
export const observationInputSchema = z.object({
  url: httpsUrlSchema, data: listingDataSchema.default({}),
  detailStatus: z.enum(["pending","captured","failed"]).default("pending"),
  missingFields: z.array(z.enum(dataFields)).default([]), absentFields: z.array(z.enum(dataFields)).default([]),
  evidence: z.array(evidenceSchema).default([]), error: z.string().optional(),
  fieldStates: fieldStatesSchema.optional(),
});
export type ObservationInput = z.infer<typeof observationInputSchema>;
export const observationSchema = observationInputSchema.extend({
  id: z.string(), externalId: z.string(), source: z.string(), runId: z.string(), provider: providerIdSchema,
  observedAt: z.string().datetime(),
  fieldObservedAt: z.partialRecord(z.enum(dataFields), z.string().datetime({offset:true})).optional(),
});
export type CaptureObservation = z.infer<typeof observationSchema>;
export const workItemSchema = z.object({id:z.string(),kind:z.enum(["discover","details"]),urls:z.array(httpsUrlSchema),cursor:z.string().optional(),repairFields:repairFieldsSchema.optional()});
export type WorkItem = z.infer<typeof workItemSchema>;
export const runStatuses = ["queued","running","completed","partial","blocked","budget_exhausted","cancelled","interrupted"] as const;
export const captureRunSchema = z.object({
  id:z.string(), request:captureRequestSchema, status:z.enum(runStatuses), createdAt:z.string(), updatedAt:z.string(),
  startedAt:z.string().optional(), endedAt:z.string().optional(), strategy:z.string(), model:z.string(),
  coverage:z.enum(["unknown","incomplete","verified_complete"]).default("unknown"),
  discovered:z.number(), captured:z.number(), failed:z.number(), duplicates:z.number(), pagesVisited:z.number(),
  pending:z.number(), observedEnd:z.boolean(), error:z.string().optional(), warnings:z.array(z.string()),
  cost:z.number(), costEstimated:z.number().optional(), costUnknown:z.boolean(), unit:z.enum(["usd","credits"]),
  activeWork:workItemSchema.optional(), remoteJobId:z.string().optional(),
});
export type CaptureRun = z.infer<typeof captureRunSchema>;
export interface RunEvent {id:number; runId:string; at:string; kind:string; message:string; artifactId?:string}
export interface ProviderBudget {provider:ProviderId; unit:"usd"|"credits"; limit:number; spent:number; estimated?:number; reserved:number; remaining:number; unknownCalls:number; configured:boolean; balance:number|null; expiresAt:string|null; checkedAt:string|null; note:string}
export interface SourceDescriptor {id:string; label:string; domains:string[]; fields:readonly string[]}
export interface LabMetadata {sources:SourceDescriptor[]; providers:Array<{id:ProviderId;label:string;model:string;strategy:string;strategies?:Array<{id:string;label:string}>;configured:boolean}>; budgets:ProviderBudget[]; live:boolean}
export interface Page<T> {items:T[];total:number;offset:number;limit:number}
export const referenceImportSchema = z.object({
  name:z.string().trim().min(1), source:z.string().default("leboncoin"),
  searchUrl:httpsUrlSchema.optional(), filters:searchFiltersSchema.optional(), capturedAt:z.string().datetime(),
  complete:z.boolean().default(false), pages:z.array(httpsUrlSchema).default([]),
  notes:z.string().default(""), requiredFields:z.array(z.enum(dataFields)).default(["title","priceEuros","propertyType","location","surfaceM2"]),
  records:z.array(observationInputSchema).min(1),
});
export type ReferenceImport = z.infer<typeof referenceImportSchema>;
export interface ReferenceRecord extends ReferenceImport {id:string; importedAt:string}
export const comparisonRequestSchema = z.object({referenceId:z.string(),runIds:z.array(z.string()).min(1)});
export type ComparisonRequest = z.infer<typeof comparisonRequestSchema>;
export const reviewSchema = z.object({
  referenceId:z.string(),runId:z.string(),listingId:z.string(),field:z.string(),
  resolution:z.enum(["confirmed_match","confirmed_error","source_changed","source_absent"]),
  note:z.string().trim().min(1), evidenceUrl:httpsUrlSchema, reviewedAt:z.string().datetime(),
});
export type EvaluationReview = z.infer<typeof reviewSchema>;
export interface Metric {numerator:number;denominator:number;ratio:number|null}
export interface Discrepancy {listingId:string;field:string;kind:"missing_listing"|"extra_listing"|"missing_field"|"different_value"|"pending_detail"|"missing_evidence";expected?:unknown;actual?:unknown;resolution?:EvaluationReview["resolution"]}
export interface RunEvaluation {runId:string;provider:ProviderId;verdict:"verified_complete"|"incomplete"|"technical_limitation"|"inconclusive";reasons:string[];recall:Metric;detailCoverage:Metric;fieldCompleteness:Metric;fieldAccuracy:Metric;imageCoverage:Metric;discrepancies:Discrepancy[];cost:number;costEstimated?:number;unit:"usd"|"credits";costPerUsefulListing:number|null;durationMs:number|null}
export interface EvaluationReport {id:string;referenceId:string;createdAt:string;referenceComplete:boolean;results:RunEvaluation[]}
