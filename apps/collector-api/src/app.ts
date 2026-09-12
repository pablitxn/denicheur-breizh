import express from "express";
import cors from "cors";
import helmet from "helmet";
import {z} from "zod";
import {captureRequestSchema,comparisonRequestSchema,providerIdSchema,referenceImportSchema,reviewSchema} from "@denicheur-breizh/collector-contracts";
import {CaptureWorker} from "./worker.js";
import {ProviderError} from "./adapter.js";
import {assertIndependentReference,evaluateRuns,importExtensionReference,reportMarkdown} from "./evaluation.js";
import {canonicalIdentity} from "./sources.js";
import {sanitizeEvidence} from "./store.js";

export function createApp(worker:CaptureWorker):express.Express{
  const app=express();app.disable("x-powered-by");app.use(helmet());
  app.use((req,res,next)=>{
    const origin=req.headers.origin;
    if((origin&&origin!==worker.config.allowedOrigin)||req.headers["sec-fetch-site"]==="cross-site")return res.status(403).json({error:{code:"origin_denied",message:"This local collector accepts only its own frontend origin."}});
    const host=req.hostname;if(!["127.0.0.1","localhost","[::1]","::1"].includes(host))return res.status(403).json({error:{code:"host_denied",message:"Local host required."}});
    next();
  });
  app.use(cors({origin:worker.config.allowedOrigin,methods:["GET","POST","OPTIONS"],allowedHeaders:["Content-Type","Idempotency-Key"]}));
  app.use(express.json({limit:"32mb"}));
  app.get("/health",(_req,res)=>res.json({ok:true,application:"collector-api"}));
  app.get("/v1/meta",(_req,res)=>res.json(worker.metadata()));
  app.post("/v1/balances/refresh",async(_req,res)=>res.json(await worker.refreshBalances()));
  app.post("/v1/balances/:provider/observation",(req,res)=>{
    const provider=providerIdSchema.parse(req.params.provider);
    const input=z.object({remaining:z.number().finite().nonnegative(),expiresAt:z.string().datetime({offset:true}).nullable(),note:z.string().trim().min(10),evidenceUrl:z.string().url().refine(value=>{const url=new URL(value);return url.protocol==="https:"&&!url.username&&!url.password&&(provider==="xai"?url.hostname==="console.x.ai":url.hostname==="firecrawl.dev"||url.hostname.endsWith(".firecrawl.dev"));},"Evidence must identify this provider's HTTPS console.")}).strict().parse(req.body);
    const evidence=new URL(input.evidenceUrl);evidence.search="";evidence.hash="";
    const note=String(sanitizeEvidence(`Console balance observation (${evidence.toString()}): ${input.note}`,[worker.config.xaiKey,worker.config.firecrawlKey]));
    worker.store.saveBalance(provider,{remaining:input.remaining,expiresAt:input.expiresAt===null?null:new Date(input.expiresAt).toISOString(),note});
    res.json(worker.metadata());
  });
  app.get("/v1/runs",(req,res)=>{const {offset,limit}=pagination(req.query);res.json(worker.store.listRuns(offset,limit));});
  app.post("/v1/runs",(req,res)=>{
    const input=captureRequestSchema.parse(req.body);const key=z.string().min(8).max(200).parse(req.header("Idempotency-Key"));
    res.status(202).json(worker.create(input,key));
  });
  app.get("/v1/runs/:id",(req,res)=>res.json(worker.store.getRun(String(req.params.id))));
  app.get("/v1/runs/:id/observations",(req,res)=>{const id=String(req.params.id);worker.store.getRun(id);const {offset,limit}=pagination(req.query);res.json(worker.store.observations(id,offset,limit));});
  app.get("/v1/runs/:id/events",(req,res)=>{worker.store.getRun(String(req.params.id));res.json({items:worker.store.events(String(req.params.id))});});
  app.get("/v1/runs/:id/artifacts/:artifactId",(req,res)=>res.json(worker.store.readArtifact(String(req.params.id),String(req.params.artifactId))));
  app.post("/v1/runs/:id/cancel",async(req,res)=>res.json(await worker.cancel(String(req.params.id))));
  app.post("/v1/runs/:id/resume",(req,res)=>res.json(worker.resume(String(req.params.id))));
  app.post("/v1/runs/:id/reprocess",(req,res)=>{z.object({}).strict().parse(req.body??{});res.json(worker.reprocessEvidence(String(req.params.id)));});
  app.get("/v1/runs/:id/export",(req,res)=>{const id=String(req.params.id),run=worker.store.getRun(id),events=worker.store.events(id);const artifactIds=[...new Set(events.flatMap(event=>event.artifactId?[event.artifactId]:[]))];res.attachment(`capture-${id}.json`).json({run,observations:worker.store.observations(id).items,events,artifacts:artifactIds.map(artifactId=>({id:artifactId,...worker.store.readArtifact(id,artifactId) as Record<string,unknown>}))});});
  app.get("/v1/references",(_req,res)=>res.json({items:worker.store.references()}));
  app.post("/v1/references",(req,res)=>{assertIndependentReference(req.body);const input=referenceImportSchema.parse(req.body);for(const record of input.records)canonicalIdentity(input.source,record.url);res.status(201).json(worker.store.importReference(input));});
  app.post("/v1/references/extension",(req,res)=>res.status(201).json(worker.store.importReference(importExtensionReference(req.body))));
  app.post("/v1/reviews",(req,res)=>{const input=reviewSchema.parse(req.body);worker.store.reference(input.referenceId);worker.store.getRun(input.runId);worker.store.saveReview(input);res.status(201).json(input);});
  app.get("/v1/evaluations",(req,res)=>{const {offset,limit}=pagination(req.query);res.json(worker.store.listReports(offset,limit));});
  app.post("/v1/evaluations",(req,res)=>{const input=comparisonRequestSchema.parse(req.body);const reference=worker.store.reference(input.referenceId);const report=evaluateRuns(reference,input.runIds.map(id=>({run:worker.store.getRun(id),observations:worker.store.observations(id).items})),worker.store.reviews());worker.store.saveReport(report);for(const result of report.results)worker.store.updateRun(result.runId,{coverage:result.verdict==="verified_complete"?"verified_complete":result.verdict==="incomplete"?"incomplete":"unknown"});res.status(201).json(report);});
  app.get("/v1/evaluations/:id",(req,res)=>res.json(worker.store.report(String(req.params.id))));
  app.get("/v1/evaluations/:id/export",(req,res)=>{const report=worker.store.report(String(req.params.id));if(req.query.format==="markdown")res.attachment(`evaluation-${report.id}.md`).type("text/markdown").send(reportMarkdown(report,worker.store.reference(report.referenceId)));else res.attachment(`evaluation-${report.id}.json`).json(report);});
  app.get("/v1/usage/unknown",(_req,res)=>res.json({items:worker.store.unknownOperations()}));
  app.post("/v1/usage/:id/reconcile",(req,res)=>{
    const input=z.object({amount:z.number().finite().nonnegative(),note:z.string().trim().min(10),evidenceUrl:z.string().url().refine(s=>{const u=new URL(s);return u.protocol==="https:"&&(u.hostname==="console.x.ai"||u.hostname==="firecrawl.dev"||u.hostname.endsWith(".firecrawl.dev"));})}).strict().parse(req.body);
    const id=String(req.params.id),operation=worker.store.operation(id);if(!operation||operation.status!=="unknown")return res.status(409).json({error:{code:"reconciliation_conflict",message:"Operation is not awaiting reconciliation."}});
    const run=worker.store.getRun(String(operation.run_id));
    const recordedUsage=operation.usage?JSON.parse(String(operation.usage)) as {final?:boolean}:undefined;
    if(operation.provider==="firecrawl"&&run.remoteJobId&&run.activeWork?.id===operation.work_id&&(recordedUsage?.final===false||Number(operation.reserved_ticks)>0||["running","queued"].includes(run.status)))return res.status(409).json({error:{code:"remote_usage_unresolved",message:"Resume polling the saved Firecrawl job until its terminal state is recorded before reconciling its final charge. Its remaining allowance is still committed."}});
    worker.store.usage(id,{amount:input.amount,unit:operation.provider==="xai"?"usd":"credits",detail:{basis:"manual_reconciliation",...input}});worker.store.artifact(String(operation.run_id),"manual_usage_reconciliation",input);worker.store.refresh(String(operation.run_id));return res.json(worker.metadata());
  });
  app.use((_req,res)=>res.status(404).json({error:{code:"not_found",message:"Collector endpoint not found."}}));
  app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    const parserType=error&&typeof error==="object"&&"type" in error?error.type:null;
    if(parserType==="entity.parse.failed")return res.status(400).json({error:{code:"invalid_json",message:"Request body is not valid JSON."}});
    if(parserType==="entity.too.large")return res.status(413).json({error:{code:"payload_too_large",message:"Request exceeds the 32 MB JSON transport limit."}});
    if(error instanceof z.ZodError)return res.status(400).json({error:{code:"invalid_request",message:error.issues.map(i=>`${i.path.join(".")}: ${i.message}`).join("; ")}});
    const message=error instanceof Error?error.message:"Unexpected collector error";const code=error instanceof ProviderError?error.code:message;
    const status=code.endsWith("NOT_FOUND")?404:code==="IDEMPOTENCY_CONFLICT"?409:error instanceof ProviderError?409:message.includes("source")||message.includes("URL")?400:500;
    return res.status(status).json({error:{code:status===500?"internal_error":code,message:status===500?"Collector could not process this request.":sanitizeEvidence(message,[worker.config.xaiKey,worker.config.firecrawlKey])}});
  });
  return app;
}
function pagination(query:Record<string,unknown>){return z.object({offset:z.coerce.number().int().min(0).default(0),limit:z.coerce.number().int().min(1).max(200).default(30)}).parse(query);}
