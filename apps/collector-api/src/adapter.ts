import type {CaptureRequest, ObservationInput, ProviderId, SourceDescriptor, WorkItem} from "@denicheur-breizh/collector-contracts";

export interface ProviderUsage {amount:number|null; unit:"usd"|"credits"; final?:boolean; detail?:unknown}
export interface ProviderStepResult {
  observations:ObservationInput[];
  nextPages:string[];
  exhausted:boolean;
  usage:ProviderUsage;
  warnings:string[];
  incomplete?:boolean;
}
export interface ProviderStepContext {
  request:CaptureRequest;
  source:SourceDescriptor & {detailPreparationScript?:string;detailRepairScript?:string;detailRepairEvidenceScript?:string};
  work:WorkItem;
  instructions:string;
  remainingBudget:number;
  remoteJobId?:string;
  signal:AbortSignal;
  onRemoteJob:(id:string)=>Promise<void>;
  onEvidence:(kind:string,payload:unknown)=>Promise<void>;
  onProgress:(message:string)=>Promise<void>;
  onUsage:(usage:ProviderUsage)=>Promise<void>;
}
export interface CaptureProvider {
  id:ProviderId;
  model:string;
  strategy:string;
  configured:boolean;
  step(context:ProviderStepContext):Promise<ProviderStepResult>;
  cancel?(remoteJobId:string):Promise<void>;
  balance?():Promise<{remaining:number|null;expiresAt:string|null;note:string}>;
}
export interface ProviderStrategyRegistry {
  resolve(provider:ProviderId,strategy:string,model?:string):CaptureProvider;
  choices(provider:ProviderId):Array<{id:string;label:string}>;
}
export class ProviderError extends Error {
  constructor(public code:string, message:string, public billingUnknown=false, public retryable=false) {super(message);this.name="ProviderError";}
}
