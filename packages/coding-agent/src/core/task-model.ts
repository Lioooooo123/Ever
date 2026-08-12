import { join } from "node:path";
import { resolveCliModel } from "./model-resolver.ts";
import { ModelRuntime } from "./model-runtime.ts";
import { SettingsManager } from "./settings-manager.ts";

export interface TaskModelIdentity {
	provider: string;
	id: string;
}

export class TaskModelConfigurationError extends Error {}

/** Resolve and pin the exact model identity before an unattended Task enters the queue. */
export async function resolveTaskModel(options: {
	agentDir: string;
	cwd: string;
	provider?: string;
	model?: string;
}): Promise<TaskModelIdentity> {
	if ((options.provider === undefined) !== (options.model === undefined)) {
		throw new Error("后台 Task 必须同时指定 --provider 和 --model");
	}
	const modelRuntime = await ModelRuntime.create({
		authPath: join(options.agentDir, "auth.json"),
		modelsPath: join(options.agentDir, "models.json"),
		allowModelNetwork: false,
		signal: AbortSignal.timeout(15_000),
	});
	if (options.provider && options.model) {
		const resolved = resolveCliModel({
			cliProvider: options.provider,
			cliModel: options.model,
			modelRuntime,
		});
		if (resolved.error) throw new Error(resolved.error);
		if (!resolved.model) throw new Error(`无法解析模型 ${options.provider}/${options.model}`);
		if (!modelRuntime.hasConfiguredAuth(resolved.model.provider)) {
			throw new TaskModelConfigurationError(`Provider ${resolved.model.provider} 尚未配置凭据`);
		}
		return { provider: resolved.model.provider, id: resolved.model.id };
	}

	const settings = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: false });
	const defaultProvider = settings.getDefaultProvider();
	const defaultModel = settings.getDefaultModel();
	const configuredDefault =
		defaultProvider && defaultModel ? modelRuntime.getModel(defaultProvider, defaultModel) : undefined;
	const selected =
		configuredDefault && modelRuntime.hasConfiguredAuth(configuredDefault.provider)
			? configuredDefault
			: modelRuntime.getAvailableSnapshot()[0];
	if (!selected) {
		throw new TaskModelConfigurationError("未找到已配置凭据的模型");
	}
	return { provider: selected.provider, id: selected.id };
}
