import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const everMessagesApi = (): ProviderStreams => lazyApi(() => import("./ever-messages.ts"));
