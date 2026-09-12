import {join} from "node:path";
import type {ProviderId} from "@denicheur-breizh/collector-contracts";
import {ProviderError,type CaptureProvider,type ProviderStrategyRegistry} from "./adapter.js";
import {readConfig,type CollectorConfig} from "./config.js";
import {CollectorStore} from "./store.js";
import {CaptureWorker} from "./worker.js";
import {createXaiProvider,createFirecrawlProvider} from "./providers/index.js";
import type {FirecrawlStrategy} from "./providers/firecrawl.js";
export function createProviderStrategyRegistry(config:CollectorConfig):ProviderStrategyRegistry {
  const cache=new Map<string,CaptureProvider>();
  return {
    choices(id){return id==="xai"?[{id:"xai-web-search-v1",label:"Hosted web search (v1)"}]:[{id:"firecrawl-agent-scrape-v1",label:"Agent + scrape (v1)"},{id:"firecrawl-agent-native-v2",label:"Native homepage flow (v2)"},{id:"firecrawl-agent-expanded-v3",label:"Agent + expanded detail (v3)"},{id:"firecrawl-detail-repair-v4",label:"Dedicated details and field repair (v4)"}];},
    resolve(id,strategy,model){
      const supported=id==="xai"?strategy==="xai-web-search-v1":["firecrawl-agent-scrape-v1","firecrawl-agent-native-v2","firecrawl-agent-expanded-v3","firecrawl-detail-repair-v4"].includes(strategy);
      if(!supported)throw new ProviderError("strategy_unavailable","The selected strategy does not belong to this provider.");
      const selectedModel=model??(id==="xai"?config.xaiModel:"spark-2");
      if(id==="firecrawl"&&selectedModel!=="spark-2")throw new ProviderError("model_unavailable","The saved Firecrawl model is unavailable; it will not be replaced silently.");
      const key=`${id}:${strategy}:${selectedModel}`;let provider=cache.get(key);
      if(!provider){provider=id==="xai"?createXaiProvider({apiKey:config.xaiKey,model:selectedModel}):createFirecrawlProvider({apiKey:config.firecrawlKey,strategy:strategy as FirecrawlStrategy});cache.set(key,provider);}
      return provider;
    },
  };
}
export function createRuntime(config:CollectorConfig=readConfig(),providers?:Map<ProviderId,CaptureProvider>){
  if(!config.live&&!providers)throw new Error("Collector test mode requires explicitly injected synthetic providers; live providers are disabled.");
  const store=new CollectorStore(config.dbPath,join(config.dataDirectory,"artifacts"),[config.xaiKey,config.firecrawlKey]);
  const strategies=providers?undefined:createProviderStrategyRegistry(config);
  const registry=providers??new Map<ProviderId,CaptureProvider>([["xai",strategies!.resolve("xai","xai-web-search-v1")],["firecrawl",strategies!.resolve("firecrawl","firecrawl-agent-scrape-v1")]]);
  return new CaptureWorker(store,registry,config,strategies);
}
