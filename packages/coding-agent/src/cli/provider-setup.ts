import { join } from "node:path";
import type { Api, AuthEvent, AuthPrompt, Model } from "@lioooooo123/ever-ai";
import type { Component, TUI } from "@lioooooo123/ever-tui";
import { ModelRuntime } from "../core/model-runtime.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { ExtensionSelectorComponent } from "../modes/interactive/components/extension-selector.ts";
import { LoginDialogComponent } from "../modes/interactive/components/login-dialog.ts";
import { ModelSelectorComponent } from "../modes/interactive/components/model-selector.ts";
import { type AuthSelectorProvider, OAuthSelectorComponent } from "../modes/interactive/components/oauth-selector.ts";
import { closeStartupTui, createStartupTui, showStartupSelector, startStartupTui } from "./startup-ui.ts";

function replaceComponent(ui: TUI, component: Component): void {
	ui.clear();
	ui.addChild(component);
	ui.setFocus(component);
	ui.requestRender();
}

export function getProviderSetupOptions(modelRuntime: ModelRuntime): AuthSelectorProvider[] {
	const options: AuthSelectorProvider[] = [];
	for (const provider of modelRuntime.getProviders()) {
		const authStatus = modelRuntime.getProviderAuthStatus(provider.id);
		const status = authStatus.configured
			? {
					type: modelRuntime.isUsingOAuth(provider.id) ? ("oauth" as const) : ("api_key" as const),
					source: authStatus.label ?? authStatus.source,
				}
			: undefined;
		if (provider.auth.oauth) {
			options.push({
				id: provider.id,
				name: provider.name,
				authType: "oauth",
				method: provider.auth.oauth,
				status,
			});
		}
		if (provider.auth.apiKey?.login) {
			options.push({
				id: provider.id,
				name: provider.name,
				authType: "api_key",
				method: provider.auth.apiKey,
				status,
			});
		}
	}
	return options.sort((left, right) => {
		const configured = Number(Boolean(right.status)) - Number(Boolean(left.status));
		if (configured !== 0) return configured;
		if (left.authType !== right.authType) return left.authType === "oauth" ? -1 : 1;
		return left.name.localeCompare(right.name);
	});
}

async function selectProvider(
	settings: SettingsManager,
	modelRuntime: ModelRuntime,
): Promise<AuthSelectorProvider | undefined> {
	const options = getProviderSetupOptions(modelRuntime);
	if (options.length === 0) throw new Error("当前没有可交互配置的 Provider");
	const ui = await createStartupTui(settings);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: AuthSelectorProvider | undefined) => {
			if (settled) return;
			settled = true;
			await closeStartupTui(ui);
			resolve(result);
		};
		const selector = new OAuthSelectorComponent(
			"login",
			options,
			(providerId, authType) =>
				void finish(options.find((option) => option.id === providerId && option.authType === authType)),
			() => void finish(undefined),
			undefined,
			"EVER / 配置 Provider",
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		startStartupTui(ui, settings);
	});
}

function promptWithSignal(prompt: Promise<string>, signal: AbortSignal | undefined): Promise<string> {
	if (!signal) return prompt;
	if (signal.aborted) return Promise.reject(new Error("Login cancelled"));
	return new Promise((resolve, reject) => {
		const abort = () => reject(new Error("Login cancelled"));
		signal.addEventListener("abort", abort, { once: true });
		prompt.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

function showAuthPrompt(ui: TUI, dialog: LoginDialogComponent, prompt: AuthPrompt): Promise<string> {
	if (prompt.type !== "select") {
		const response =
			prompt.type === "manual_code"
				? dialog.showManualInput(prompt.message)
				: dialog.showPrompt(prompt.message, prompt.placeholder);
		return promptWithSignal(response, prompt.signal);
	}
	const response = new Promise<string>((resolve, reject) => {
		const labels = prompt.options.map((option) => option.label);
		const restoreDialog = () => replaceComponent(ui, dialog);
		const selector = new ExtensionSelectorComponent(
			prompt.message,
			labels,
			(label) => {
				restoreDialog();
				const selected = prompt.options.find((option) => option.label === label);
				if (selected) resolve(selected.id);
				else reject(new Error("Login cancelled"));
			},
			() => {
				restoreDialog();
				reject(new Error("Login cancelled"));
			},
		);
		replaceComponent(ui, selector);
	});
	return promptWithSignal(response, prompt.signal);
}

function notifyAuthDialog(dialog: LoginDialogComponent, event: AuthEvent): void {
	if (event.type === "auth_url") dialog.showAuth(event.url, event.instructions);
	else if (event.type === "device_code") {
		dialog.showDeviceCode(event);
		dialog.showWaiting("等待认证完成");
	} else if (event.type === "info") dialog.showInfo(event.message, event.links);
	else dialog.showProgress(event.message);
}

async function authenticateProvider(
	settings: SettingsManager,
	modelRuntime: ModelRuntime,
	provider: AuthSelectorProvider,
): Promise<boolean> {
	const ui = await createStartupTui(settings);
	let cancelled = false;
	const dialog = new LoginDialogComponent(
		ui,
		provider.id,
		(success) => {
			if (!success) cancelled = true;
		},
		provider.name,
		provider.authType === "oauth" ? `登录 ${provider.name}` : `配置 ${provider.name}`,
	);
	ui.addChild(dialog);
	ui.setFocus(dialog);
	startStartupTui(ui, settings);
	try {
		await modelRuntime.login(provider.id, provider.authType, {
			signal: dialog.signal,
			prompt: (prompt) => showAuthPrompt(ui, dialog, prompt),
			notify: (event) => notifyAuthDialog(dialog, event),
		});
		return true;
	} catch (error) {
		if (cancelled || (error instanceof Error && error.message === "Login cancelled")) return false;
		throw error;
	} finally {
		await closeStartupTui(ui);
	}
}

async function selectModel(settings: SettingsManager, modelRuntime: ModelRuntime): Promise<Model<Api> | undefined> {
	const provider = settings.getDefaultProvider();
	const modelId = settings.getDefaultModel();
	const current = provider && modelId ? modelRuntime.getModel(provider, modelId) : undefined;
	const ui = await createStartupTui(settings);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (model: Model<Api> | undefined) => {
			if (settled) return;
			settled = true;
			await closeStartupTui(ui);
			resolve(model);
		};
		const selector = new ModelSelectorComponent(
			ui,
			current,
			settings,
			modelRuntime,
			[],
			(model) => void finish(model),
			() => void finish(undefined),
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		startStartupTui(ui, settings);
	});
}

export async function runProviderAndModelSetup(agentDir: string, cwd: string): Promise<boolean> {
	const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: true,
		modelRefreshTimeoutMs: 15_000,
		signal: AbortSignal.timeout(20_000),
	});
	const hasConfiguredModel = modelRuntime.getAvailableSnapshot().length > 0;
	const action = hasConfiguredModel
		? await showStartupSelector(settings, "PROVIDER 与模型", [
				{ label: "选择默认模型", value: "model" as const },
				{ label: "添加或更新 Provider", value: "provider" as const },
				{ label: "返回 Task Home", value: "back" as const },
			])
		: "provider";
	if (!action || action === "back") return false;
	if (action === "provider") {
		const provider = await selectProvider(settings, modelRuntime);
		if (!provider || !(await authenticateProvider(settings, modelRuntime, provider))) return false;
	}
	return (await selectModel(settings, modelRuntime)) !== undefined;
}
