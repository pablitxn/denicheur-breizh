import {resolve,join} from "node:path";
import {fileURLToPath} from "node:url";

const appRoot=fileURLToPath(new URL("../",import.meta.url));
export interface CollectorConfig {port:number;dataDirectory:string;dbPath:string;xaiKey:string;firecrawlKey:string;xaiModel:string;xaiBudget:number;firecrawlBudget:number;xaiExpiresAt:string|null;firecrawlExpiresAt:string|null;allowedOrigin:string;live:boolean}
function positive(value:string|undefined, fallback:number) {const n=value?Number(value):fallback;if(!Number.isFinite(n)||n<=0)throw new Error("Collector numeric configuration must be positive.");return n;}
function expiry(value:string|undefined) {if(!value)return null;if(!Number.isFinite(Date.parse(value)))throw new Error("Invalid provider expiry timestamp.");return new Date(value).toISOString();}
export function readConfig(env:NodeJS.ProcessEnv=process.env):CollectorConfig {
  const dataDirectory=resolve(env.COLLECTOR_DATA_DIR??join(appRoot,".data"));
  const mainData=resolve(appRoot,"../api/.data");
  if(dataDirectory===mainData||dataDirectory.startsWith(mainData+"/"))throw new Error("Collector storage cannot use the main API data directory.");
  const port=positive(env.COLLECTOR_PORT,4315);if(!Number.isInteger(port)||port>65535)throw new Error("Invalid collector port.");
  return {port,dataDirectory,dbPath:join(dataDirectory,"collector.sqlite"),xaiKey:env.XAI_API_KEY??"",firecrawlKey:env.FIRECRAWL_API_KEY??"",xaiModel:env.COLLECTOR_XAI_MODEL??"grok-4.6",xaiBudget:positive(env.COLLECTOR_XAI_BUDGET_USD,25),firecrawlBudget:positive(env.COLLECTOR_FIRECRAWL_BUDGET_CREDITS,5000),xaiExpiresAt:expiry(env.COLLECTOR_XAI_EXPIRES_AT),firecrawlExpiresAt:expiry(env.COLLECTOR_FIRECRAWL_EXPIRES_AT),allowedOrigin:env.COLLECTOR_ALLOWED_ORIGIN??"http://127.0.0.1:5175",live:env.COLLECTOR_TEST_MODE!=="1"};
}
