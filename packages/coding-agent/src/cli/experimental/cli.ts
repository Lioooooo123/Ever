import { type ClientCommandContext, clientCommand } from "./commands/client.ts";
import { type EverCommandContext, everCommand } from "./commands/ever.ts";
import { type ServerCommandContext, serverCommand } from "./commands/server.ts";

export type ExperimentalCliContext = EverCommandContext & ServerCommandContext & ClientCommandContext;

export const experimentalCli = everCommand.command(serverCommand).command(clientCommand);
