import { APP_NAME } from "./config.ts";
import { loadWorkerStartup } from "./core/worker-startup.ts";

process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
loadWorkerStartup();
