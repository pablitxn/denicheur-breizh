import {DatabaseSync} from "node:sqlite";
import {randomUUID} from "node:crypto";
import {mkdirSync,writeFileSync,readFileSync,chmodSync} from "node:fs";
import {join,dirname} from "node:path";
import type {CaptureObservation,CaptureRequest,CaptureRun,EvaluationReport,EvaluationReview,Page,ProviderBudget,ProviderId,ReferenceImport,ReferenceRecord,RunEvent,WorkItem} from "@denicheur-breizh/collector-contracts";
import {fingerprint,pageKey} from "./sources.js";
import type {ProviderUsage} from "./adapter.js";

type Row=Record<string,unknown>;
const now=()=>new Date().toISOString();
const unitScale=(provider:ProviderId)=>provider==="xai"?10_000_000_000:1;
export function sanitizeEvidence(value:unknown,secrets:string[]=[]):unknown {
  if(typeof value==="string") {let s=value;for(const secret of secrets.filter(Boolean))s=s.split(secret).join("[REDACTED]");return s.replace(/Bearer\s+[A-Za-z0-9._-]+/gi,"Bearer [REDACTED]").replace(/([?&](?:token|api_key|key|signature|sig)=)[^&\s"']+/gi,"$1[REDACTED]");}
  if(Array.isArray(value))return value.map(v=>sanitizeEvidence(v,secrets));
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/^(?:authorization|api[-_]?key|access[-_]?token|secret|cookie|set-cookie|password)$/i.test(k)?"[REDACTED]":sanitizeEvidence(v,secrets)]));
  return value;
}
export class CollectorStore {
  readonly db:DatabaseSync;
  constructor(readonly path:string,readonly artifactsDirectory:string,private secrets:string[]=[]){
    if(path!==":memory:")mkdirSync(dirname(path),{recursive:true,mode:0o700});mkdirSync(artifactsDirectory,{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS collector_migrations(version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO collector_migrations VALUES(1);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,provider TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,idempotency_key TEXT UNIQUE NOT NULL,request_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,run_id TEXT NOT NULL REFERENCES runs(id),work_key TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(run_id,work_key));
      CREATE TABLE IF NOT EXISTS observations(run_id TEXT NOT NULL REFERENCES runs(id),id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(run_id,id));
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,at TEXT NOT NULL,kind TEXT NOT NULL,message TEXT NOT NULL,artifact_id TEXT);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,work_id TEXT NOT NULL,provider TEXT NOT NULL,status TEXT NOT NULL,amount_ticks INTEGER,reserved_ticks INTEGER NOT NULL,usage TEXT);
      CREATE TABLE IF NOT EXISTS provider_balances(provider TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reference_cases(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY AUTOINCREMENT,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,data TEXT NOT NULL);`);
    if(!(this.db.prepare("PRAGMA table_info(operations)").all() as Row[]).some(row=>row.name==="estimated_ticks")){
      this.db.exec("ALTER TABLE operations ADD COLUMN estimated_ticks INTEGER NOT NULL DEFAULT 0; INSERT OR IGNORE INTO collector_migrations VALUES(2);");
      this.db.exec("UPDATE operations SET estimated_ticks=coalesce(amount_ticks,0),amount_ticks=0 WHERE json_extract(usage,'$.detail.estimated')=1;");
    }
    if(path!==":memory:")chmodSync(path,0o600);
  }
  close(){this.db.close();}
  transaction<T>(fn:()=>T):T {this.db.exec("BEGIN IMMEDIATE");try{const result=fn();this.db.exec("COMMIT");return result;}catch(e){this.db.exec("ROLLBACK");throw e;}}
  createRun(request:CaptureRequest,key:string,strategy:string,model:string,initialize?:(run:CaptureRun)=>void):{run:CaptureRun;created:boolean} {
    return this.transaction(()=>{
      const old=this.db.prepare("SELECT data,request_hash FROM runs WHERE idempotency_key=?").get(key) as Row|undefined;
      if(old){if(old.request_hash!==fingerprint(request))throw new Error("IDEMPOTENCY_CONFLICT");return{run:JSON.parse(String(old.data)),created:false};}
      const run:CaptureRun={id:randomUUID(),request,status:"queued",createdAt:now(),updatedAt:now(),strategy,model,coverage:"unknown",discovered:0,captured:0,failed:0,duplicates:0,pagesVisited:0,pending:0,observedEnd:false,warnings:[],cost:0,costUnknown:false,unit:request.provider==="xai"?"usd":"credits"};
      this.db.prepare("INSERT INTO runs VALUES(?,?,?,?,?,?)").run(run.id,request.provider,run.status,JSON.stringify(run),key,fingerprint(request));
      if(request.mode==="urls")for(const url of [...new Set(request.urls)])this.enqueue(run.id,"details",[url],`details:${url}`);
      else this.enqueue(run.id,"discover",request.searchUrl?[request.searchUrl]:[],request.searchUrl?`discover:${pageKey(request.searchUrl)}`:"discover:initial");
      initialize?.(run);
      this.event(run.id,"created","Capture queued.");return {run:this.refresh(run.id),created:true};
    });
  }
  getRun(id:string):CaptureRun {const row=this.db.prepare("SELECT data FROM runs WHERE id=?").get(id) as Row|undefined;if(!row)throw new Error("RUN_NOT_FOUND");return JSON.parse(String(row.data));}
  updateRun(id:string,patch:Partial<CaptureRun>):CaptureRun {const run={...this.getRun(id),...patch,updatedAt:now()};this.db.prepare("UPDATE runs SET status=?,data=? WHERE id=?").run(run.status,JSON.stringify(run),id);return run;}
  listRuns(offset=0,limit=30):Page<CaptureRun>{const rows=this.db.prepare("SELECT data FROM runs ORDER BY rowid DESC LIMIT ? OFFSET ?").all(limit,offset) as Row[];return {items:rows.map(r=>JSON.parse(String(r.data))),total:Number((this.db.prepare("SELECT count(*) n FROM runs").get() as Row).n),offset,limit};}
  runnable(provider:ProviderId):CaptureRun|undefined {const row=this.db.prepare("SELECT data FROM runs WHERE provider=? AND status='queued' ORDER BY rowid LIMIT 1").get(provider) as Row|undefined;return row?JSON.parse(String(row.data)):undefined;}
  enqueue(runId:string,kind:WorkItem["kind"],urls:string[],key:string,cursor?:string):boolean {const work:WorkItem={id:randomUUID(),kind,urls,...(cursor?{cursor}:{})};return this.db.prepare("INSERT OR IGNORE INTO work(id,run_id,work_key,status,data) VALUES(?,?,?,'pending',?)").run(work.id,runId,key,JSON.stringify(work)).changes>0;}
  nextWork(runId:string):WorkItem|undefined {const row=this.db.prepare("SELECT data FROM work WHERE run_id=? AND status IN ('active','pending') ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,seq LIMIT 1").get(runId) as Row|undefined;return row?JSON.parse(String(row.data)):undefined;}
  setWorkStatus(workId:string,status:"active"|"done"|"failed"|"pending"){this.db.prepare("UPDATE work SET status=? WHERE id=?").run(status,workId);}
  updateWork(work:WorkItem){this.db.prepare("UPDATE work SET data=? WHERE id=?").run(JSON.stringify(work),work.id);}
  retryFailed(runId:string){this.db.prepare("UPDATE work SET status='pending' WHERE run_id=? AND status='failed'").run(runId);}
  saveObservation(value:CaptureObservation,options:{replaceDetailStatus?:boolean;replaceSnapshot?:boolean}={}):boolean {
    const row=this.db.prepare("SELECT data FROM observations WHERE run_id=? AND id=?").get(value.runId,value.id) as Row|undefined;
    if(row){const old=JSON.parse(String(row.data)) as CaptureObservation;
      if(old.source!==value.source||old.provider!==value.provider||old.externalId!==value.externalId)throw new Error("OBSERVATION_PROVENANCE_CONFLICT");
      const evidence=[...new Map([...old.evidence,...value.evidence].map(item=>[JSON.stringify(item),item])).values()];
      if(!options.replaceDetailStatus&&old.detailStatus==="captured"&&value.detailStatus!=="captured"){
        // A failed request or a discovery card is not a newer complete detail snapshot.
        value={...old,evidence};
      }else if(value.detailStatus==="captured"||options.replaceSnapshot){
        // Full details replace the snapshot, including galleries and observed absence.
        // The original responses remain immutable artifacts, not inferred current data.
        value={...value,data:{...value.data},evidence};
      }else{
        const data={...old.data,...Object.fromEntries(Object.entries(value.data).filter(([,v])=>v!==null&&v!==undefined)),imageUrls:[...new Set([...(old.data.imageUrls??[]),...(value.data.imageUrls??[])])],features:[...new Set([...(old.data.features??[]),...(value.data.features??[])])]};
        for(const field of value.absentFields)delete data[field];
        value={...value,data,evidence};
      }
    }
    this.db.prepare("INSERT INTO observations VALUES(?,?,?) ON CONFLICT(run_id,id) DO UPDATE SET data=excluded.data").run(value.runId,value.id,JSON.stringify(value));return !row;
  }
  observation(runId:string,id:string):CaptureObservation|undefined {const r=this.db.prepare("SELECT data FROM observations WHERE run_id=? AND id=?").get(runId,id) as Row|undefined;return r?JSON.parse(String(r.data)):undefined;}
  observations(runId:string,offset=0,limit?:number):Page<CaptureObservation>{const rows=(limit===undefined?this.db.prepare("SELECT data FROM observations WHERE run_id=? ORDER BY rowid").all(runId):this.db.prepare("SELECT data FROM observations WHERE run_id=? ORDER BY rowid LIMIT ? OFFSET ?").all(runId,limit,offset)) as Row[];return{items:rows.map(r=>JSON.parse(String(r.data))),total:Number((this.db.prepare("SELECT count(*) n FROM observations WHERE run_id=?").get(runId) as Row).n),offset,limit:limit??rows.length};}
  refresh(runId:string):CaptureRun {
    const counts=this.db.prepare("SELECT count(*) total,sum(CASE WHEN json_extract(data,'$.detailStatus')='captured' THEN 1 ELSE 0 END) captured,sum(CASE WHEN json_extract(data,'$.detailStatus')='failed' THEN 1 ELSE 0 END) failed FROM observations WHERE run_id=?").get(runId) as Row;
    const pending=this.db.prepare("SELECT count(*) n FROM work WHERE run_id=? AND status IN ('pending','active')").get(runId) as Row;
    const costs=this.db.prepare("SELECT sum(amount_ticks) amount,sum(estimated_ticks) estimated,sum(CASE WHEN status='unknown' THEN 1 ELSE 0 END) unknowns FROM operations WHERE run_id=?").get(runId) as Row;
    const run=this.getRun(runId),scale=unitScale(run.request.provider);
    return this.updateRun(runId,{discovered:Number(counts.total),captured:Number(counts.captured??0),failed:Number(counts.failed??0),pending:Number(pending.n),cost:Number(costs.amount??0)/scale,costEstimated:Number(costs.estimated??0)/scale,costUnknown:Number(costs.unknowns??0)>0});
  }
  event(runId:string,kind:string,message:string,artifactId?:string){this.db.prepare("INSERT INTO events(run_id,at,kind,message,artifact_id) VALUES(?,?,?,?,?)").run(runId,now(),kind,String(sanitizeEvidence(message,this.secrets)),artifactId??null);}
  events(runId:string):RunEvent[]{return (this.db.prepare("SELECT * FROM events WHERE run_id=? ORDER BY id").all(runId) as Row[]).map(r=>({id:Number(r.id),runId:String(r.run_id),at:String(r.at),kind:String(r.kind),message:String(r.message),...(r.artifact_id?{artifactId:String(r.artifact_id)}:{})}));}
  artifact(runId:string,kind:string,payload:unknown):string {const id=randomUUID();writeFileSync(join(this.artifactsDirectory,`${id}.json`),JSON.stringify({runId,kind,at:now(),payload:sanitizeEvidence(payload,this.secrets)},null,2),{mode:0o600});this.event(runId,"evidence",kind,id);return id;}
  readArtifact(runId:string,id:string):unknown {if(!/^[a-f0-9-]{36}$/.test(id)||!this.events(runId).some(e=>e.artifactId===id))throw new Error("ARTIFACT_NOT_FOUND");return JSON.parse(readFileSync(join(this.artifactsDirectory,`${id}.json`),"utf8"));}
  startOperation(run:CaptureRun,work:WorkItem,reserve:number,resumeRemote=false):string {
    const existing=(resumeRemote?this.db.prepare("SELECT id FROM operations WHERE work_id=? ORDER BY rowid DESC LIMIT 1"):this.db.prepare("SELECT id FROM operations WHERE work_id=? AND status='pending' ORDER BY rowid DESC LIMIT 1")).get(work.id) as Row|undefined;
    if(existing)return String(existing.id);
    const id=randomUUID();this.db.prepare("INSERT INTO operations(id,run_id,work_id,provider,status,amount_ticks,reserved_ticks,usage,estimated_ticks) VALUES(?,?,?,?,'pending',NULL,?,NULL,0)").run(id,run.id,work.id,run.request.provider,Math.round(reserve*unitScale(run.request.provider)));return id;
  }
  usage(id:string,usage:ProviderUsage){
    const row=this.db.prepare("SELECT provider,amount_ticks,estimated_ticks,reserved_ticks FROM operations WHERE id=?").get(id) as Row|undefined;if(!row)throw new Error("OPERATION_NOT_FOUND");
    if(usage.unit!==(row.provider==="xai"?"usd":"credits")||(usage.amount!==null&&(!Number.isFinite(usage.amount)||usage.amount<0)))throw new Error("INVALID_PROVIDER_USAGE");
    const detail=usage.detail&&typeof usage.detail==="object"?usage.detail as Record<string,unknown>:{};
    const scale=unitScale(row.provider as ProviderId),ticks=usage.amount===null?null:Math.round(usage.amount*scale),estimated=detail.estimated===true;
    // Unknown final billing preserves the known lower bound; it never becomes a free operation.
    const lowerBound=typeof detail.lastReportedAmount==="number"&&Number.isFinite(detail.lastReportedAmount)&&detail.lastReportedAmount>=0?Math.round(detail.lastReportedAmount*scale):0;
    const actualTicks=ticks===null?Math.max(Number(row.amount_ticks??0),estimated?0:lowerBound):estimated?0:ticks;
    const estimatedTicks=ticks===null?Math.max(Number(row.estimated_ticks??0),estimated?lowerBound:0):estimated?ticks:0;
    const committedTicks=Number(row.reserved_ticks)+Number(row.amount_ticks??0)+Number(row.estimated_ticks??0);
    const reservedTicks=usage.final===false?Math.max(0,committedTicks-actualTicks-estimatedTicks):0;
    this.db.prepare("UPDATE operations SET amount_ticks=?,estimated_ticks=?,status=?,reserved_ticks=?,usage=? WHERE id=?").run(actualTicks,estimatedTicks,usage.amount===null?"unknown":"known",reservedTicks,JSON.stringify(usage),id);
  }
  operation(id:string):Row{return this.db.prepare("SELECT * FROM operations WHERE id=?").get(id) as Row;}
  budget(provider:ProviderId,limit:number,configured:boolean,expiresAt:string|null):ProviderBudget {const row=this.db.prepare("SELECT sum(amount_ticks) spent,sum(estimated_ticks) estimated,sum(reserved_ticks) reserved,sum(CASE WHEN status='unknown' THEN 1 ELSE 0 END) unknowns FROM operations WHERE provider=?").get(provider) as Row;const balanceRow=this.db.prepare("SELECT data FROM provider_balances WHERE provider=?").get(provider) as Row|undefined;const balance=balanceRow?JSON.parse(String(balanceRow.data)):null;const scale=unitScale(provider),spent=Number(row.spent??0)/scale,estimated=Number(row.estimated??0)/scale,reserved=Number(row.reserved??0)/scale;return{provider,unit:provider==="xai"?"usd":"credits",limit,spent,estimated,reserved,remaining:Math.max(0,Math.min(limit-spent-estimated-reserved,balance?.remaining??Infinity)),unknownCalls:Number(row.unknowns??0),configured,balance:balance?.remaining??null,expiresAt:balance?.expiresAt??expiresAt,checkedAt:balance?.checkedAt??null,note:balance?.note??"Promotion balance and expiry have not been verified."};}
  saveBalance(provider:ProviderId,balance:{remaining:number|null;expiresAt:string|null;note:string}){this.db.prepare("INSERT INTO provider_balances VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET data=excluded.data").run(provider,JSON.stringify({...balance,checkedAt:now()}));}
  unknownOperations(provider?:ProviderId):Row[]{return (provider?this.db.prepare("SELECT id,run_id,work_id,provider,status,usage FROM operations WHERE status='unknown' AND provider=?").all(provider):this.db.prepare("SELECT id,run_id,work_id,provider,status,usage FROM operations WHERE status='unknown'").all()) as Row[];}
  recover(){
    for(const row of this.db.prepare("SELECT data FROM runs WHERE status IN ('running','interrupted')").all() as Row[]){
      const run=JSON.parse(String(row.data)) as CaptureRun;
      if(run.request.provider==="firecrawl"&&run.remoteJobId&&run.activeWork){
        this.setWorkStatus(run.activeWork.id,"active");this.updateRun(run.id,{status:"queued"});this.event(run.id,"recovery","Resuming the existing Firecrawl job; no new submission.");
      }else if(run.status==="running"){
        this.db.prepare("UPDATE operations SET status='unknown',reserved_ticks=0 WHERE run_id=? AND status='pending'").run(run.id);
        this.updateRun(run.id,{status:"interrupted",error:"The last work item was interrupted. Reconcile any unknown usage before retrying."});this.refresh(run.id);this.event(run.id,"recovery","Uncertain request will not be automatically submitted again.");
      }
    }
  }
  importReference(input:ReferenceImport):ReferenceRecord{const ref={...input,id:randomUUID(),importedAt:now()};this.db.prepare("INSERT INTO reference_cases VALUES(?,?)").run(ref.id,JSON.stringify(ref));return ref;}
  references():ReferenceRecord[]{return(this.db.prepare("SELECT data FROM reference_cases ORDER BY rowid DESC").all() as Row[]).map(r=>JSON.parse(String(r.data)));}
  reference(id:string):ReferenceRecord {const row=this.db.prepare("SELECT data FROM reference_cases WHERE id=?").get(id) as Row|undefined;if(!row)throw new Error("REFERENCE_NOT_FOUND");return JSON.parse(String(row.data));}
  saveReview(review:EvaluationReview){this.db.prepare("INSERT INTO reviews(data) VALUES(?)").run(JSON.stringify(review));}
  reviews():EvaluationReview[]{return(this.db.prepare("SELECT data FROM reviews ORDER BY id").all() as Row[]).map(r=>JSON.parse(String(r.data)));}
  saveReport(report:EvaluationReport){this.db.prepare("INSERT INTO reports VALUES(?,?)").run(report.id,JSON.stringify(report));}
  listReports(offset=0,limit=30):Page<Pick<EvaluationReport,"id"|"referenceId"|"createdAt">&{referenceName:string;results:Array<Pick<EvaluationReport["results"][number],"runId"|"provider"|"verdict">>}>{
    const rows=this.db.prepare("SELECT data FROM reports ORDER BY rowid DESC LIMIT ? OFFSET ?").all(limit,offset) as Row[];
    return{items:rows.map(row=>{const report=JSON.parse(String(row.data)) as EvaluationReport;return{id:report.id,referenceId:report.referenceId,createdAt:report.createdAt,referenceName:this.reference(report.referenceId).name,results:report.results.map(({runId,provider,verdict})=>({runId,provider,verdict}))};}),total:Number((this.db.prepare("SELECT count(*) n FROM reports").get() as Row).n),offset,limit};
  }
  report(id:string):EvaluationReport{const row=this.db.prepare("SELECT data FROM reports WHERE id=?").get(id) as Row|undefined;if(!row)throw new Error("REPORT_NOT_FOUND");return JSON.parse(String(row.data));}
}
