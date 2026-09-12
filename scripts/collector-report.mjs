import {mkdir,writeFile,readFile,readdir} from "node:fs/promises";
import {resolve,join} from "node:path";
import {fileURLToPath} from "node:url";

const root=resolve(fileURLToPath(new URL("../",import.meta.url)));
const base=new URL(process.env.COLLECTOR_API_URL??"http://127.0.0.1:4315");
if(base.protocol!=="http:"||!["127.0.0.1","localhost","[::1]"].includes(base.hostname)||base.username||base.password)throw new Error("Report reads only the local collector API.");
const directory=resolve(process.argv[2]??join(root,"apps/collector-api/.data/reports"));
await mkdir(directory,{recursive:true,mode:0o700});
async function get(path){const response=await fetch(new URL(path,base));if(!response.ok)throw new Error(`Collector returned HTTP ${response.status}`);return response.json();}
const runs=[];
for(let offset=0;;){const page=await get(`/v1/runs?offset=${offset}&limit=200`);runs.push(...page.items);offset+=page.items.length;if(offset>=page.total)break;if(!page.items.length)throw new Error("Run pagination stopped before the reported total.");}
const captures=[];
for(const run of runs){const capture=await get(`/v1/runs/${encodeURIComponent(run.id)}/export`);captures.push(capture);await writeFile(join(directory,`capture-${run.id}.json`),JSON.stringify(capture,null,2)+"\n",{mode:0o600});}
// Use the run snapshot belonging to each export rather than an older list response.
runs.splice(0,runs.length,...captures.map(capture=>capture.run));
const metadata=await get("/v1/meta");
const references=await get("/v1/references");
const evaluations=[];
for(let offset=0;;){const page=await get(`/v1/evaluations?offset=${offset}&limit=100`);for(const item of page.items){const evaluation=await get(`/v1/evaluations/${encodeURIComponent(item.id)}`);evaluations.push(evaluation);await writeFile(join(directory,`evaluation-${item.id}.json`),JSON.stringify(evaluation,null,2)+"\n",{mode:0o600});}offset+=page.items.length;if(offset>=page.total)break;if(!page.items.length)throw new Error("Evaluation pagination stopped before the reported total.");}
const referenceSessions=[];
const referenceRoot=join(root,".data/collector-reference");
try{for(const entry of await readdir(referenceRoot,{withFileTypes:true})){if(!entry.isDirectory())continue;try{const latest=JSON.parse(await readFile(join(referenceRoot,entry.name,"latest.json"),"utf8"));referenceSessions.push({session:entry.name,runId:latest.runId,status:latest.status,records:latest.records,complete:latest.complete});}catch{}}}catch{}
let balanceObservation=null;
try{balanceObservation=JSON.parse(await readFile(join(root,"apps/collector-api/.data/console-balance-observation.json"),"utf8"));}catch{}
const report={generatedAt:new Date().toISOString(),metadata,balanceObservation,references:references.items,referenceSessions,captures,evaluations,
  conclusion:{verifiedRunIds:runs.filter(r=>r.coverage==="verified_complete").map(r=>r.id),
    verdict:runs.some(r=>r.coverage==="verified_complete")?"See individual independently verified evaluations":"No complete provider capture has been verified",
    limitations:["A finished request or provider-reported result total does not certify full coverage.","Known-URL extraction and complete-search discovery are different experiments.","References marked incomplete or historical cannot establish current native-search coverage.","Simulated tests are software evidence, not live provider capability evidence."]}};
await writeFile(join(directory,"campaign.json"),JSON.stringify(report,null,2)+"\n",{mode:0o600});
const cell=value=>String(value??"—").replaceAll("|","\\|").replaceAll("\n"," ");
const amount=(value,unit)=>unit==="usd"?`US$${Number(value).toFixed(6)}`:`${value} créditos`;
const lines=["# Evaluación real del laboratorio", "",`Generado: ${report.generatedAt}.`,"",
  `**${report.conclusion.verifiedRunIds.length?"Consultar los veredictos individuales de cobertura.":"Ninguna captura completa verificada. No hay un ganador validado."}**`,"",
  "Las identidades registradas en modo URLs conocidas incluyen las URLs solicitadas que fallaron. Los detalles capturados son extracciones que pasaron la validación del laboratorio: su fidelidad y la cobertura completa todavía requieren contraste con una referencia independiente. Los totales mencionados por un agente no constituyen un denominador verificado.","",
  "| Proveedor | Modo | Estrategia | Ejecución | Estado | Identidades | Detalles capturados | Pendientes | Confirmado | Estimado | Cobertura |",
  "|---|---|---|---|---|---:|---:|---:|---|---|---|"];
for(const r of runs)lines.push(`| ${[r.request.provider,r.request.mode,r.strategy,r.request.name,r.status,r.discovered,r.captured,r.pending,amount(r.cost,r.unit),amount(r.costEstimated??0,r.unit),r.coverage].map(cell).join(" | ")} |`);
lines.push("","## Presupuesto acumulado","","| Proveedor | Autorizado | Confirmado | Estimado | Comprometido | Disponible | Inciertas |","|---|---|---|---|---|---|---:|");
for(const b of metadata.budgets)lines.push(`| ${[b.provider,amount(b.limit,b.unit),amount(b.spent,b.unit),amount(b.estimated??0,b.unit),amount(b.reserved,b.unit),amount(b.remaining,b.unit),b.unknownCalls].map(cell).join(" | ")} |`);
lines.push("","## Evidencias e incidencias","");
for(const r of runs){lines.push(`### ${r.request.provider}: ${r.request.name}`,"",`ID: \`${r.id}\`. Inicio: ${r.startedAt??r.createdAt}; fin: ${r.endedAt??"en curso"}. Modelo: ${r.model}.`,"",`[Exportación con evidencias](capture-${r.id}.json).`);if(r.error)lines.push("",`Error: ${r.error}`);if(r.warnings.length)lines.push("","Advertencias conservadas literalmente; las afirmaciones del proveedor requieren contraste:","");for(const warning of [...new Set(r.warnings)])lines.push(`- ${warning}`);lines.push("");}
lines.push("## Referencias","");
if(!references.items.length)lines.push("No se importó ninguna referencia.");
for(const r of references.items)lines.push(`- ${r.name}: ${r.records.length} registros; completa=${r.complete}; observación=${r.capturedAt}. ${r.notes}`);
for(const r of referenceSessions)lines.push(`- Extensión aislada ${r.session}: estado=${r.status}, registros=${r.records}, completa=${r.complete}. Run: ${r.runId}.`);
lines.push("","## Comparaciones persistidas","");
if(!evaluations.length)lines.push("Todavía no hay comparaciones guardadas.");
for(const e of evaluations)lines.push(`- [${e.createdAt}](evaluation-${e.id}.json): ${e.results.map(result=>`${result.provider}: ${result.verdict}`).join("; ")}. Referencia completa: ${e.referenceComplete}.`);
lines.push("","## Límites de la conclusión","",...report.conclusion.limitations.map(s=>`- ${s}`),"",
  "La siguiente integración con el catálogo exige una referencia actual reconciliada y el 100% de sus IDs, páginas, detalles y campos presentes. Un bloqueo reproducible o una extracción parcial sirven para elegir el siguiente experimento; no permiten declarar cobertura completa.","");
await writeFile(join(directory,"campaign.md"),lines.join("\n"),{mode:0o600});
console.log(`Report: ${join(directory,"campaign.md")}`);
console.log(`Evidence bundle: ${join(directory,"campaign.json")}`);
