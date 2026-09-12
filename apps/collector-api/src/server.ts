import {createApp} from "./app.js";
import {createRuntime} from "./runtime.js";
const worker=createRuntime();
const server=createApp(worker).listen(worker.config.port,"127.0.0.1",()=>{console.log(`Collector API: http://127.0.0.1:${worker.config.port}`);worker.start();});
let closing=false;
async function shutdown(){if(closing)return;closing=true;server.close();await worker.stop();worker.store.close();}
process.on("SIGINT",()=>{void shutdown();});process.on("SIGTERM",()=>{void shutdown();});
