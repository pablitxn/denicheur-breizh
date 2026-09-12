import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {Server} from "node:http";
import request from "supertest";
import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {createApp} from "./app.js";
import {readConfig} from "./config.js";
import {CollectorStore,sanitizeEvidence} from "./store.js";
import {CaptureWorker} from "./worker.js";
import type {CaptureProvider} from "./adapter.js";
import {captureRequestSchema,dataFields,referenceImportSchema,type EvaluationReport} from "@denicheur-breizh/collector-contracts";

describe("collector HTTP boundary",()=>{
  let dir:string,store:CollectorStore,worker:CaptureWorker,calls:number,app:Server;
  const url="https://www.leboncoin.fr/ad/ventes_immobilieres/123456";
  const input={name:"API contract",provider:"xai",mode:"urls",urls:[url]};
  beforeEach(async()=>{
    dir=mkdtempSync(join(tmpdir(),"collector-api-test-"));calls=0;
    const config=readConfig({COLLECTOR_DATA_DIR:dir,XAI_API_KEY:"test-secret-never-serialized",COLLECTOR_TEST_MODE:"1"});
    store=new CollectorStore(config.dbPath,join(dir,"artifacts"),[config.xaiKey]);
    const provider:CaptureProvider={id:"xai",configured:true,model:"synthetic",strategy:"test-v1",async step(){calls++;return{observations:[{url,data:{title:"Observed",imageUrls:[]},detailStatus:"captured",missingFields:[],absentFields:dataFields.filter(field=>field!=="title"),evidence:[{url,text:"Observed listing page",kind:"page"}]}],nextPages:[],exhausted:false,warnings:[],usage:{amount:0.001,unit:"usd"}};}};
    worker=new CaptureWorker(store,new Map([["xai",provider]]),config);
    app=await new Promise<Server>((resolve,reject)=>{const server=createApp(worker).listen(0,"127.0.0.1",()=>resolve(server));server.on("error",reject);});
  });
  afterEach(async()=>{await worker.stop();if(app)await new Promise<void>((resolve,reject)=>app.close(error=>error?reject(error):resolve()));store.close();rmSync(dir,{recursive:true,force:true});});
  it("deduplicates repeated paid submissions and rejects changed input with the same key",async()=>{
    const a=await request(app).post("/v1/runs").set("Idempotency-Key","retry-same-request").send(input).expect(202);
    const b=await request(app).post("/v1/runs").set("Idempotency-Key","retry-same-request").send(input).expect(202);
    expect(a.body.id).toBe(b.body.id);await worker.drain();expect(calls).toBe(1);
    await request(app).post("/v1/runs").set("Idempotency-Key","retry-same-request").send({...input,name:"Changed"}).expect(409);
    const exported=await request(app).get(`/v1/runs/${a.body.id}/export`).expect(200);
    expect(exported.body.observations).toHaveLength(1);expect(exported.body.run.coverage).toBe("unknown");
  });
  it("blocks foreign origins and DNS rebinding hosts before any paid work",async()=>{
    await request(app).post("/v1/runs").set("Origin","https://evil.example").send(input).expect(403);
    await request(app).get("/v1/meta").set("Host","evil.example").expect(403);
    expect(calls).toBe(0);
    const response=await request(app).get("/v1/meta").expect(200);
    expect(JSON.stringify(response.body)).not.toContain("test-secret-never-serialized");
  });
  it("rejects bad filters and result pagination without dispatch",async()=>{
    await request(app).post("/v1/runs").set("Idempotency-Key","invalid-input").send({...input,filters:{ignoredUnsupported:true}}).expect(400);
    await request(app).get("/v1/runs?limit=201").expect(400);expect(calls).toBe(0);
  });
  it("redacts credentials in nested evidence and limits artifact access to its execution",async()=>{
    const response=await request(app).post("/v1/runs").set("Idempotency-Key","artifact-request").send(input).expect(202);await worker.drain();
    const id=store.artifact(response.body.id,"test",{authorization:"secret",nested:["test-secret-never-serialized","Bearer abcdef",{cookie:"private"}]});
    const text=readFileSync(join(dir,"artifacts",`${id}.json`),"utf8");
    expect(text).not.toContain("test-secret-never-serialized");expect(text).not.toContain("abcdef");expect(text).not.toContain("private");
    await request(app).get(`/v1/runs/${response.body.id}/artifacts/${id}`).expect(200);
    await request(app).get(`/v1/runs/another-run/artifacts/${id}`).expect(404);
    const exported=await request(app).get(`/v1/runs/${response.body.id}/export`).expect(200);
    expect(exported.body.artifacts).toContainEqual(expect.objectContaining({id,kind:"test",payload:expect.objectContaining({authorization:"[REDACTED]"})}));
    expect(JSON.stringify(exported.body.artifacts)).not.toContain("test-secret-never-serialized");
    expect(JSON.stringify(exported.body.artifacts)).not.toContain("abcdef");
    expect(sanitizeEvidence("https://example.com?api_key=hidden&safe=ok")).not.toContain("hidden");
  });
  it("returns actionable JSON and transport errors without dispatching work",async()=>{
    const invalid=await request(app).post("/v1/runs").set("Content-Type","application/json").send("{broken").expect(400);
    expect(invalid.body.error.code).toBe("invalid_json");
    const oversized=await request(app).post("/v1/references").set("Content-Type","application/json").send(JSON.stringify({notes:"a".repeat(32*1024*1024)})).expect(413);
    expect(oversized.body.error.code).toBe("payload_too_large");expect(calls).toBe(0);
  });
  it("rejects collector observations as an independent reference before provenance is stripped",async()=>{
    const reference={name:"Self comparison",source:"leboncoin",capturedAt:new Date().toISOString(),complete:true,pages:[url],notes:"This should not be accepted as independent.",records:[{url,data:{title:"Own result"},provider:"xai",runId:"original-collector-run",detailStatus:"captured"}]};
    for(const endpoint of ["/v1/references","/v1/references/extension"]){const response=await request(app).post(endpoint).send(reference).expect(409);expect(response.body.error.code).toBe("reference_not_independent");}
    expect(store.references()).toHaveLength(0);
  });
  it("persists an evidenced console balance separately with precise expiry and source validation",async()=>{
    const input={remaining:35,expiresAt:"2026-09-12T23:00:00+02:00",note:"Observed directly in authenticated console. test-secret-never-serialized",evidenceUrl:"https://console.x.ai/team/billing?token=hidden#credit"};
    const response=await request(app).post("/v1/balances/xai/observation").send(input).expect(200);
    const budget=response.body.budgets.find((item:{provider:string})=>item.provider==="xai");
    expect(budget.balance).toBe(35);expect(budget.expiresAt).toBe("2026-09-12T21:00:00.000Z");expect(budget.spent).toBe(0);
    expect(budget.note).toContain("https://console.x.ai/team/billing");expect(budget.note).not.toContain("hidden");expect(budget.note).not.toContain("test-secret-never-serialized");
    await request(app).post("/v1/balances/xai/observation").send({...input,expiresAt:null,remaining:0}).expect(200);
    for(const patch of [{evidenceUrl:"https://firecrawl.dev/app"},{evidenceUrl:"https://console.x.ai.evil.example/"},{evidenceUrl:"https://user:pass@console.x.ai/"},{expiresAt:"today"},{remaining:-1},{remaining:"35"},{note:""}])await request(app).post("/v1/balances/xai/observation").send({...input,...patch}).expect(400);
    await request(app).post("/v1/balances/other/observation").send(input).expect(400);expect(calls).toBe(0);
  });
  it("repairs only stored evidence through a strict local endpoint without a second provider dispatch",async()=>{
    const created=await request(app).post("/v1/runs").set("Idempotency-Key","offline-reprocess-request").send(input).expect(202);await worker.drain();
    const before=store.observations(created.body.id).items[0]!;
    store.saveObservation({...before,data:{...before.data,imageUrls:["https://img.leboncoin.fr/stale.jpg"]}});
    await request(app).post(`/v1/runs/${created.body.id}/reprocess`).send({provider:"firecrawl"}).expect(400);
    const response=await request(app).post(`/v1/runs/${created.body.id}/reprocess`).send({}).expect(200);
    expect(response.body.replayed).toBe(1);expect(store.observations(created.body.id).items[0]!.data.imageUrls).toEqual([]);expect(calls).toBe(1);
    store.updateRun(created.body.id,{status:"running"});
    await request(app).post(`/v1/runs/${created.body.id}/reprocess`).send({}).expect(409);expect(calls).toBe(1);
  });
  it("returns persisted evaluation history newest first with pagination and reference names",async()=>{
    const reference=store.importReference(referenceImportSchema.parse({name:"Independent extension reference",source:"leboncoin",capturedAt:"2026-09-12T08:00:00.000Z",records:[{url,data:{title:"Reference"}}]}));
    const first:EvaluationReport={id:"first-report",referenceId:reference.id,createdAt:"2026-09-12T09:00:00.000Z",referenceComplete:false,results:[]};
    const second:EvaluationReport={...first,id:"second-report",createdAt:"2026-09-12T10:00:00.000Z",results:[{runId:"run-id",provider:"xai",verdict:"inconclusive",reasons:["Reference incomplete"],recall:{numerator:0,denominator:1,ratio:0},detailCoverage:{numerator:0,denominator:0,ratio:null},fieldCompleteness:{numerator:0,denominator:1,ratio:0},fieldAccuracy:{numerator:0,denominator:1,ratio:0},imageCoverage:{numerator:0,denominator:0,ratio:null},discrepancies:[],cost:0,unit:"usd",costPerUsefulListing:null,durationMs:null}]};
    store.saveReport(first);store.saveReport(second);
    const page=await request(app).get("/v1/evaluations?offset=0&limit=1").expect(200);
    expect(page.body).toEqual({total:2,offset:0,limit:1,items:[{id:second.id,referenceId:reference.id,createdAt:second.createdAt,referenceName:reference.name,results:[{runId:"run-id",provider:"xai",verdict:"inconclusive"}]}]});
    const next=await request(app).get("/v1/evaluations?offset=1&limit=1").expect(200);expect(next.body.items[0].id).toBe(first.id);
    await request(app).get(`/v1/evaluations/${second.id}`).expect(200);await request(app).get("/v1/evaluations?limit=201").expect(400);
  });
  it("keeps a recoverable Firecrawl job's allowance reserved until terminal status precedes manual reconciliation",async()=>{
    const capture=captureRequestSchema.parse({...input,provider:"firecrawl"});
    const run=store.createRun(capture,"recoverable-reconcile","firecrawl-agent-scrape-v1","spark-2").run;
    const work=store.nextWork(run.id)!;
    const operation=store.startOperation(run,work,100);
    store.usage(operation,{amount:3,unit:"credits",final:false});
    store.usage(operation,{amount:null,unit:"credits",final:false,detail:{basis:"remote_job_unreconciled",lastReportedAmount:3}});
    store.updateRun(run.id,{status:"interrupted",activeWork:work,remoteJobId:"still-running-agent"});
    const reconciliation={amount:7,note:"Console usage observed for this operation.",evidenceUrl:"https://firecrawl.dev/app/usage"};
    const response=await request(app).post(`/v1/usage/${operation}/reconcile`).send(reconciliation).expect(409);
    expect(response.body.error.code).toBe("remote_usage_unresolved");
    expect(store.budget("firecrawl",100,true,null)).toMatchObject({spent:3,reserved:97,remaining:0,unknownCalls:1});
    expect(store.events(run.id).some(event=>event.message==="manual_usage_reconciliation")).toBe(false);
    // A provider terminal status may omit the charge; that final missing amount is reconcilable.
    store.usage(operation,{amount:null,unit:"credits",final:true,detail:{basis:"terminal_usage_unreported"}});
    await request(app).post(`/v1/usage/${operation}/reconcile`).send(reconciliation).expect(200);
    expect(store.budget("firecrawl",100,true,null)).toMatchObject({spent:7,reserved:0,remaining:93,unknownCalls:0});
    await request(app).post(`/v1/usage/${operation}/reconcile`).send(reconciliation).expect(409);
    expect(calls).toBe(0);
  });
});
