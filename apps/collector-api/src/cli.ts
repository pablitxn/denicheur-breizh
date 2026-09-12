import {readFile,writeFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {captureRequestSchema} from "@denicheur-breizh/collector-contracts";

const [command,...args]=process.argv.slice(2);
const base=process.env.COLLECTOR_API_URL??"http://127.0.0.1:4315";
if(!["127.0.0.1","localhost","[::1]"].includes(new URL(base).hostname))throw new Error("CLI connects only to the local collector API.");
async function request(path:string,body?:unknown){const response=await fetch(`${base}${path}`,{...(body===undefined?{}:{method:"POST",body:JSON.stringify(body)}),headers:{"Content-Type":"application/json","Idempotency-Key":randomUUID()}});const value=await response.json();if(!response.ok)throw new Error(JSON.stringify(value));return value;}
try{
  switch(command){
    case "status":console.log(JSON.stringify(await request("/v1/meta"),null,2));break;
    case "runs":console.log(JSON.stringify(await request("/v1/runs?limit=200"),null,2));break;
    case "events":console.log(JSON.stringify(await request(`/v1/runs/${encodeURIComponent(args[0]??"")}/events`),null,2));break;
    case "balances":console.log(JSON.stringify(await request("/v1/balances/refresh",{}),null,2));break;
    case "observe-balance":{if(!args[0]||!args[1])throw new Error("observe-balance requires provider and observation JSON file");console.log(JSON.stringify(await request(`/v1/balances/${encodeURIComponent(args[0])}/observation`,JSON.parse(await readFile(args[1],"utf8"))),null,2));break;}
    case "capture":{if(!args[0])throw new Error("capture requires a request JSON file");const input=captureRequestSchema.parse(JSON.parse(await readFile(args[0],"utf8")));console.log(JSON.stringify(await request("/v1/runs",input),null,2));break;}
    case "run":console.log(JSON.stringify(await request(`/v1/runs/${encodeURIComponent(args[0]??"")}`),null,2));break;
    case "cancel":case "resume":console.log(JSON.stringify(await request(`/v1/runs/${encodeURIComponent(args[0]??"")}/${command}`,{}),null,2));break;
    case "repair-plan":{if(!args[0])throw new Error("repair-plan requires a source run ID");console.log(JSON.stringify(await request(`/v1/runs/${encodeURIComponent(args[0])}/repair-plan`),null,2));break;}
    case "repair":{if(!args[0])throw new Error("repair requires a source run ID and optional selection JSON file");const input=args[1]?JSON.parse(await readFile(args[1],"utf8")):{};console.log(JSON.stringify(await request(`/v1/runs/${encodeURIComponent(args[0])}/repair`,input),null,2));break;}
    case "reprocess":{if(!args[0])throw new Error("reprocess requires a completed or stopped run ID");console.log(JSON.stringify(await request(`/v1/runs/${encodeURIComponent(args[0])}/reprocess`,{}),null,2));break;}
    case "import-extension":case "import-reference":{if(!args[0])throw new Error("import requires a JSON file");console.log(JSON.stringify(await request(command==="import-extension"?"/v1/references/extension":"/v1/references",JSON.parse(await readFile(args[0],"utf8"))),null,2));break;}
    case "evaluate":{if(!args[0]||args.length<2)throw new Error("evaluate requires referenceId and runId(s)");console.log(JSON.stringify(await request("/v1/evaluations",{referenceId:args[0],runIds:args.slice(1)}),null,2));break;}
    case "export":{if(!args[0]||!args[1])throw new Error("export requires runId and output JSON path");await writeFile(args[1],JSON.stringify(await request(`/v1/runs/${encodeURIComponent(args[0])}/export`),null,2),{mode:0o600});console.log(`Exported ${args[1]}`);break;}
    default:console.log("Collector CLI (start collector-api first)\n  status | balances | runs | capture request.json | run ID | events ID\n  cancel ID | resume ID | reprocess ID | export ID output.json\n  repair-plan ID | repair ID [selection.json]\n  observe-balance xai|firecrawl observation.json\n    JSON fields: remaining (number), expiresAt (ISO timestamp or null), note, evidenceUrl (provider console)\n  import-extension file.json | import-reference file.json\n  evaluate referenceId runId [runId...]\nReprocess validates this run's stored responses and repairs snapshots locally; it does not contact providers.");
  }
}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
