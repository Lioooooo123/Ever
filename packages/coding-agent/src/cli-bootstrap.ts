import { APP_NAME } from "./config.ts";
import { loadWorkerStartup } from "./core/worker-startup.ts";

process.title = APP_NAME;
process.env.EVER_CODING_AGENT = "true";
process.env.AI_AGENT = "ever";
loadWorkerStartup();
