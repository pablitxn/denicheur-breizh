import {observationInputSchema,type CaptureObservation,type CaptureRequest,type CaptureRun,type LabMetadata,type ProviderId,type WorkItem,type RepairRequest} from "@denicheur-breizh/collector-contracts";
import {ProviderError,type CaptureProvider,type ProviderUsage,type ProviderStrategyRegistry} from "./adapter.js";
import type {CollectorConfig} from "./config.js";
import {CollectorStore} from "./store.js";
import {canonicalIdentity,fingerprint,getSource,pageKey,sourceRegistry,validateSourceRequest} from "./sources.js";
import {detailGaps} from "./capture-quality.js";
import {SOURCE_DESCRIPTION_COLLAPSED} from "./providers/scrape-quality.js";
import {reprocessStoredEvidence} from "./reprocess-evidence.js";
import {createRepair,mergeRepairFields,prepareRepair,REPAIR_STRATEGY} from "./repair.js";

export class CaptureWorker {
  private active=new Map<ProviderId,{runId:string;controller:AbortController;promise:Promise<void>}>();
  private stopped=false;
  private timer:ReturnType<typeof setInterval>|undefined;
  constructor(readonly store:CollectorStore,readonly providers:Map<ProviderId,CaptureProvider>,readonly config:CollectorConfig,readonly strategies?:ProviderStrategyRegistry){}
  resolveStrategy(id:ProviderId,strategy?:string,model?:string):CaptureProvider {
    const base=this.providers.get(id);if(!base)throw new ProviderError("provider_unconfigured","Provider is not registered.");
    const selected=strategy??base.strategy;
    const provider=this.strategies?this.strategies.resolve(id,selected,model):base;
    if(provider.id!==id||provider.strategy!==selected)throw new ProviderError("strategy_unavailable","The saved provider strategy is unavailable; choose a strategy for a new run.");
    if(model&&provider.model!==model)throw new ProviderError("model_unavailable","The saved provider model is unavailable; a resumed run cannot silently change models.");
    return provider;
  }
  budget(provider:ProviderId){return this.store.budget(provider,provider==="xai"?this.config.xaiBudget:this.config.firecrawlBudget,Boolean(this.providers.get(provider)?.configured),provider==="xai"?this.config.xaiExpiresAt:this.config.firecrawlExpiresAt);}
  metadata():LabMetadata{return {sources:[...sourceRegistry.values()].map(({id,label,domains,fields})=>({id,label,domains,fields})),providers:[...this.providers.values()].map(({id,model,strategy,configured})=>({id,label:id==="xai"?"xAI":"Firecrawl",model,strategy,strategies:this.strategies?.choices(id)??[{id:strategy,label:strategy}],configured})),budgets:[this.budget("xai"),this.budget("firecrawl")],live:this.config.live};}
  async refreshBalances(){for(const provider of this.providers.values()){if(!provider.configured||!provider.balance)continue;try{this.store.saveBalance(provider.id,await provider.balance());}catch{this.store.saveBalance(provider.id,{remaining:null,expiresAt:null,note:"Unable to verify provider balance. Check the provider console."});}}return this.metadata();}
  create(request:CaptureRequest,key:string):CaptureRun {if(request.repair)throw new ProviderError("repair_endpoint_required","Create linked repairs through the source run's repair endpoint.");validateSourceRequest(request);const provider=this.resolveStrategy(request.provider,request.strategy);if(!provider.configured)throw new ProviderError("provider_unconfigured","Configure this provider on the collector backend first.");const result=this.store.createRun(request,key,provider.strategy,provider.model);this.wake();return result.run;}
  repairPlan(id:string){return prepareRepair(this.store,id).plan;}
  repair(id:string,input:RepairRequest,key:string):CaptureRun {
    const parent=this.store.getRun(id);
    if([...this.active.values()].some(active=>active.runId===id))throw new ProviderError("repair_unavailable","Wait for the source worker to finish before creating a repair.");
    if(parent.request.provider!=="firecrawl")throw new ProviderError("repair_unavailable","Only Firecrawl observations can use the Firecrawl repair strategy.");
    const provider=this.resolveStrategy("firecrawl",REPAIR_STRATEGY);
    const plan=this.repairPlan(id);
    const paid=plan.items.some(item=>(!input.listingIds||input.listingIds.includes(item.listingId))&&item.fields.some(field=>(!input.fields||input.fields.includes(field))&&!item.locallyResolved.includes(field)));
    if(paid&&!provider.configured)throw new ProviderError("provider_unconfigured","Configure Firecrawl on the collector backend first.");
    const run=createRepair(this.store,id,input,key,provider.model);this.wake();return run;
  }
  start(){this.store.recover();this.timer=setInterval(()=>this.wake(),1000);this.timer.unref();this.wake();}
  wake(){if(this.stopped)return;for(const base of this.providers.values()){if(this.active.has(base.id)||!base.configured)continue;const run=this.store.runnable(base.id);if(!run)continue;let provider:CaptureProvider;try{provider=this.resolveStrategy(base.id,run.strategy,run.model);}catch(error){this.store.updateRun(run.id,{status:"blocked",coverage:"incomplete",error:error instanceof Error?error.message:"Saved strategy is unavailable."});this.store.event(run.id,"strategy_unavailable","The saved strategy/model was not replaced by the current default.");continue;}const controller=new AbortController();const promise=this.execute(run.id,provider,controller.signal).catch(error=>{this.store.updateRun(run.id,{status:"interrupted",coverage:"incomplete",error:"Worker stopped unexpectedly; inspect events before resuming."});this.store.event(run.id,"worker_error",error instanceof Error?error.message:String(error));}).finally(()=>{this.active.delete(provider.id);if(!this.stopped)this.wake();});this.active.set(provider.id,{runId:run.id,controller,promise});}}
  async drain(){this.wake();while(this.active.size)await Promise.all([...this.active.values()].map(a=>a.promise));}
  async stop(){this.stopped=true;if(this.timer)clearInterval(this.timer);for(const active of this.active.values())active.controller.abort(new Error("Backend shutdown"));await Promise.all([...this.active.values()].map(a=>a.promise));}
  async cancel(id:string):Promise<CaptureRun>{const run=this.store.getRun(id);if(!["queued","running"].includes(run.status)&&!run.remoteJobId)return run;this.store.updateRun(id,{status:"cancelled",coverage:"incomplete",endedAt:new Date().toISOString()});const active=this.active.get(run.request.provider);if(active?.runId===id)active.controller.abort(new Error("User cancelled"));if(run.remoteJobId){try{await this.resolveStrategy(run.request.provider,run.strategy,run.model).cancel?.(run.remoteJobId);}catch{this.store.event(id,"cancel_warning","Remote cancellation could not be confirmed. The provider may continue billing.");}}this.store.event(id,"cancelled","New dispatches stopped; in-flight provider billing is reconciled separately.");return this.store.refresh(id);}
  resume(id:string):CaptureRun {
    const run=this.store.getRun(id);if(["queued","running"].includes(run.status))return run;
    this.resolveStrategy(run.request.provider,run.strategy,run.model);
    const remote=run.request.provider==="firecrawl"&&Boolean(run.remoteJobId&&run.activeWork);
    if(!remote&&this.budget(run.request.provider).unknownCalls)throw new ProviderError("usage_unknown","Reconcile unknown provider consumption before resuming.");
    this.store.retryFailed(id);if(remote)this.store.setWorkStatus(run.activeWork!.id,"active");
    // Explicit resume also upgrades historical captures whose old status concealed known gaps.
    const source=getSource(run.request.source);
    for(const observation of this.store.observations(id).items){
      // Deterministic raw-page failures are persisted in missingFields; old response warnings
      // must not downgrade a newer repaired snapshot. Legacy responses are audited by replay.
      const gaps=detailGaps(observation,source.detailFields,run.warnings.filter(warning=>!warning.startsWith(SOURCE_DESCRIPTION_COLLAPSED)));
      if(observation.detailStatus!=="captured"||!gaps.length)continue;
      this.store.saveObservation({...observation,detailStatus:"pending",missingFields:gaps,error:`Full detail not recovered: ${gaps.join(", ")}.`},{replaceDetailStatus:true});
      this.store.enqueue(id,"details",[observation.url],`detail-completion:${observation.id}`);
    }
    this.store.updateRun(id,{status:"queued",coverage:"unknown",error:undefined,endedAt:undefined,...(!remote?{activeWork:undefined,remoteJobId:undefined}:{})});
    this.store.event(id,"resumed",remote?"Resuming the saved remote job to reconcile its result and charge; no new submission.":"Explicitly resumed from pending/failed work; completed work is preserved.");this.wake();return this.store.refresh(id);
  }
  reprocessEvidence(id:string){
    const run=this.store.getRun(id);
    if(["queued","running"].includes(run.status)||run.activeWork||run.remoteJobId||[...this.active.values()].some(active=>active.runId===id))throw new ProviderError("reprocess_active_run","Stop the execution and resolve its in-flight work before replaying stored evidence.");
    return reprocessStoredEvidence(this.store,id);
  }
  private async execute(runId:string,provider:CaptureProvider,signal:AbortSignal){
    let run=this.store.getRun(runId);this.store.updateRun(runId,{status:"running",startedAt:run.startedAt??new Date().toISOString(),error:undefined});
    while(!signal.aborted){
      run=this.store.getRun(runId);if(run.status==="cancelled")break;
      const work=this.store.nextWork(runId);if(!work)break;
      if(run.request.repair){
        const target=work.kind==="details"&&work.urls.length===1?run.request.repair.targets.find(item=>item.listingId===canonicalIdentity(run.request.source,work.urls[0]!).id):undefined;
        if(!target)throw new ProviderError("repair_target_invalid","Persisted repair work is outside this execution's immutable target selection.");
        work.repairFields=(work.repairFields??target.fields).filter(field=>target.fields.includes(field));
        if(!work.repairFields.length){this.store.setWorkStatus(work.id,"done");continue;}
        this.store.updateWork(work);
      }
      if(work.repairFields){
        const snapshot=this.store.observation(runId,canonicalIdentity(run.request.source,work.urls[0]!).id);
        if(snapshot){const gaps=detailGaps(snapshot);const remaining=work.repairFields.filter(field=>gaps.includes(field));
          if(!remaining.length){this.store.setWorkStatus(work.id,"done");continue;}
          if(remaining.length!==work.repairFields.length){work.repairFields=remaining;this.store.updateWork(work);}
        }
      }
      if(provider.id==="firecrawl"&&provider.balance&&!run.remoteJobId){try{this.store.saveBalance(provider.id,await provider.balance());}catch{this.store.event(runId,"balance_warning","Balance could not be refreshed; local budget remains enforced.");}}
      const budget=this.budget(provider.id);
      const isRemoteResume=Boolean(run.remoteJobId&&run.activeWork?.id===work.id);
      if(!isRemoteResume&&(budget.unknownCalls||budget.remaining<=0||(budget.expiresAt&&Date.parse(budget.expiresAt)<=Date.now()))){this.store.updateRun(runId,{status:budget.unknownCalls?"interrupted":"budget_exhausted",coverage:"incomplete",error:budget.unknownCalls?"Unknown provider consumption must be reconciled.":"Available budget or promotion exhausted."});break;}
      this.store.setWorkStatus(work.id,"active");this.store.updateRun(runId,{activeWork:work});
      const operation=this.store.startOperation(run,work,provider.id==="firecrawl"?(work.kind==="details"?Math.min(5,budget.remaining):budget.remaining):0,isRemoteResume);
      let usageRecorded=false;
      let latestUsage:ProviderUsage|undefined;
      const onUsage=async(usage:ProviderUsage)=>{usageRecorded=true;latestUsage=usage;this.store.usage(operation,usage);this.store.refresh(runId);if(usage.detail)this.store.artifact(runId,"usage",usage);};
      try{
        const known=work.kind==="discover"&&work.cursor?this.store.observations(runId).items.map(o=>o.externalId):[];const source=getSource(run.request.source);
        this.store.event(runId,"dispatch",`${work.kind}: ${work.urls.join(", ")||"native search discovery"}`);
        const result=await provider.step({request:run.request,source,work,instructions:source.instructions(run.request,work,known),remainingBudget:isRemoteResume?Math.max(budget.remaining,budget.reserved):budget.remaining,...(isRemoteResume?{remoteJobId:run.remoteJobId}:{}),signal,onRemoteJob:async(id)=>{this.store.updateRun(runId,{remoteJobId:id});this.store.event(runId,"remote_job",`Remote job persisted: ${id}`);if(this.store.getRun(runId).status==="cancelled"){try{await provider.cancel?.(id);}catch{this.store.event(runId,"cancel_warning","A job ID arrived after cancellation; its remote cancellation could not be confirmed.");}}},onEvidence:async(kind,payload)=>{this.store.artifact(runId,kind,payload);},onProgress:async(message)=>{this.store.event(runId,"progress",message);},onUsage});
        await onUsage(result.usage);
        const observedAt=new Date().toISOString();
        this.store.artifact(runId,"step_result",{...result,observedAt,context:{runId,source:source.id,provider:provider.id,strategy:run.strategy,model:run.model,work}});
        let added=0,duplicateCount=0,invalid=0,detailsIncomplete=false;
        const requestedIds=new Set(work.kind==="details"?work.urls.map(url=>canonicalIdentity(source.id,url).id):[]);
        const receivedIds=new Set<string>();
        for(const raw of result.observations){
          const parsed=observationInputSchema.safeParse(raw);if(!parsed.success){invalid++;continue;}
          let identity;try{identity=canonicalIdentity(source.id,parsed.data.url);}catch{invalid++;continue;}
          if(work.kind==="details"&&!requestedIds.has(identity.id)){invalid++;continue;}
          receivedIds.add(identity.id);
          let observation:CaptureObservation={...parsed.data,...identity,source:source.id,runId,provider:provider.id,observedAt};
          if(work.kind==="discover"&&run.strategy===REPAIR_STRATEGY)observation.detailStatus="pending";
          const repairBase=work.repairFields?this.store.observation(runId,identity.id):undefined;
          if(work.repairFields&&repairBase){
            observation={...mergeRepairFields(repairBase,observation,work.repairFields,observedAt),observedAt};
            this.store.artifact(runId,"repair_field_result",{listingId:identity.id,parentRunId:run.request.repair?.parentRunId,requestedFields:work.repairFields,remainingFields:observation.missingFields,observedAt});
          }
          if(observation.detailStatus==="captured"&&!observation.evidence.some(e=>{try{return canonicalIdentity(source.id,e.url).id===identity.id&&e.text.trim().length>0;}catch{return false;}})){
            observation.detailStatus="failed";observation.error="No detail-page evidence was supplied.";
          }
          const qualityWarnings=work.repairFields&&!work.repairFields.includes("description")?result.warnings.filter(warning=>!warning.startsWith(SOURCE_DESCRIPTION_COLLAPSED)):result.warnings;
          const gaps=detailGaps(observation,source.detailFields,qualityWarnings);
          if(observation.detailStatus==="captured"&&gaps.length){
            observation.missingFields=gaps;observation.detailStatus=work.kind==="discover"?"pending":"failed";
            observation.error=`Full detail ${work.kind==="details"?"still missing after targeted extraction":"not recovered"}: ${gaps.join(", ")}.`;
            this.store.event(runId,"detail_incomplete",`${identity.id}: ${observation.error}`);
          }
          if(work.kind==="details"&&observation.detailStatus!=="captured")detailsIncomplete=true;
          const previous=this.store.observation(runId,identity.id);
          const previousIncomplete=previous?.detailStatus==="captured"&&detailGaps(previous,source.detailFields,this.store.getRun(runId).warnings.filter(warning=>!warning.startsWith(SOURCE_DESCRIPTION_COLLAPSED))).length>0;
          const fresh=this.store.saveObservation(observation,{replaceDetailStatus:previousIncomplete||Boolean(work.repairFields),replaceSnapshot:Boolean(work.repairFields)});if(fresh)added++;else duplicateCount++;
          if(this.store.observation(runId,identity.id)?.detailStatus!=="captured"&&work.kind==="discover")this.store.enqueue(runId,"details",[identity.url],`details:${identity.id}`);
        }
        if(work.kind==="details")for(const url of work.urls){const identity=canonicalIdentity(source.id,url);if(!receivedIds.has(identity.id)){
          detailsIncomplete=true;const baseline=work.repairFields?this.store.observation(runId,identity.id):undefined;
          this.store.saveObservation(baseline?{...baseline,detailStatus:"failed",error:"Provider omitted the requested listing; previous evidence and unresolved fields are retained."}:{...identity,runId,source:source.id,provider:provider.id,observedAt:new Date().toISOString(),data:{},detailStatus:"failed",missingFields:[],absentFields:[],evidence:[],error:"Provider omitted the requested listing."},{replaceSnapshot:Boolean(baseline),replaceDetailStatus:Boolean(baseline)});
        }}
        let enqueued=0,repeated=false;
        if(work.kind==="discover")for(const url of result.nextPages){if(!source.accepts(url)){invalid++;continue;}const key=pageKey(url);if(this.store.enqueue(runId,"discover",[url],`discover:${key}`))enqueued++;else repeated=true;}
        let stalled=false;
        if(work.kind==="discover"&&!result.exhausted&&!enqueued){
          if(added>0&&!repeated){const ids=this.store.observations(runId).items.map(o=>o.id).sort();const cursor=`Continue after the ${ids.length} already discovered listings. Last discovery step: ${work.id}`;enqueued+=Number(this.store.enqueue(runId,"discover",work.urls,`continue:${fingerprint(ids)}`,cursor));}
          else stalled=true;
        }
        if(((!work.repairFields&&result.incomplete)||detailsIncomplete)&&work.kind==="details")stalled=true;
        if(repeated)stalled=true;
        const current=this.store.getRun(runId);const warnings=[...current.warnings,...result.warnings,...(invalid?[`${invalid} invalid/off-source observations or page URLs rejected.`]:[]),...(stalled?["Discovery or extraction stopped making progress; completeness is not established."]:[]),...(repeated?["Provider repeated an already visited page."]:[])];
        this.store.setWorkStatus(work.id,stalled||invalid?"failed":"done");
        this.store.updateRun(runId,{pagesVisited:current.pagesVisited+(work.kind==="discover"?1:0),observedEnd:current.observedEnd||result.exhausted,duplicates:current.duplicates+duplicateCount,warnings,activeWork:undefined,remoteJobId:undefined});
        this.store.refresh(runId);
        if(result.usage.amount===null){this.store.updateRun(runId,{status:"interrupted",coverage:"incomplete",error:"Captured data retained; provider usage is unknown. Reconcile before another dispatch."});break;}
      }catch(error){
        const e=error instanceof ProviderError?error:new ProviderError("worker_error",error instanceof Error?error.message:String(error),!usageRecorded);
        if(!usageRecorded)await onUsage({amount:e.billingUnknown?null:0,unit:provider.id==="xai"?"usd":"credits",final:!e.billingUnknown});
        else if(e.billingUnknown&&latestUsage?.amount!==null)await onUsage({amount:null,unit:provider.id==="xai"?"usd":"credits",final:false,detail:{basis:"interrupted_request",lastReportedAmount:latestUsage?.amount??null}});
        this.store.artifact(runId,"step_error",{code:e.code,message:e.message,billingUnknown:e.billingUnknown,work});
        this.store.setWorkStatus(work.id,"failed");
        if(e.code==="provider_output_truncated"&&work.urls.length>1){for(const url of work.urls)this.store.enqueue(runId,work.kind,[url],`split:${work.id}:${url}`);this.store.setWorkStatus(work.id,"done");this.store.updateRun(runId,{activeWork:undefined,remoteJobId:undefined,warnings:[...this.store.getRun(runId).warnings,"Truncated output split into smaller work items."]});continue;}
        if(e.code==="provider_output_truncated"&&!e.billingUnknown&&latestUsage?.amount!=null&&work.kind==="discover"&&!work.cursor?.includes("compact-discovery-v1")){
          const cursor="compact-discovery-v1: The previous response exceeded its output capacity. Return ONLY listing URL identities and native next-page links for the current page. Every observation must have pending detailStatus, null data fields/empty arrays, no description or image content. The worker will extract every listing detail separately. Include every observed listing; never apply a result limit.";
          this.store.enqueue(runId,"discover",work.urls,`compact-discovery:${work.id}`,cursor);this.store.setWorkStatus(work.id,"done");
          this.store.updateRun(runId,{activeWork:undefined,remoteJobId:undefined,warnings:[...this.store.getRun(runId).warnings,"Truncated discovery switched to URL-only extraction; listing details remain separate work."]});continue;
        }
        const cancelled=this.store.getRun(runId).status==="cancelled";
        const status=cancelled?"cancelled":e.billingUnknown||signal.aborted?"interrupted":e.code==="budget_exhausted"?"budget_exhausted":e.code==="provider_output_invalid"||e.code==="provider_output_truncated"?"partial":"blocked";
        const recoverableRemote=provider.id==="firecrawl"&&Boolean(this.store.getRun(runId).remoteJobId)&&e.billingUnknown;
        this.store.updateRun(runId,{status,coverage:"incomplete",error:e.message,...(!recoverableRemote?{activeWork:undefined,remoteJobId:undefined}:{})});
        this.store.event(runId,"error",`${e.code}: ${e.message}`);break;
      }
    }
    run=this.store.refresh(runId);
    if(run.status==="running"){
      const failedWork=Number((this.store.db.prepare("SELECT count(*) n FROM work WHERE run_id=? AND status='failed'").get(runId) as {n:number}).n);
      const completeWork=run.pending===0&&failedWork===0&&run.failed===0&&run.discovered>0;
      this.store.updateRun(runId,{status:signal.aborted?"interrupted":completeWork?"completed":"partial",coverage:completeWork?"unknown":"incomplete",activeWork:undefined,remoteJobId:undefined});
    }
    this.store.updateRun(runId,{endedAt:new Date().toISOString()});this.store.event(runId,"finished","Execution ended. Coverage requires independent reference verification.");
  }
}
