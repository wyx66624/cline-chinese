import { Anthropic } from "@anthropic-ai/sdk"
import axios from "axios"
import crypto from "crypto"
import { execa } from "execa"
import fs from "fs/promises"
import os from "os"
import pWaitFor from "p-wait-for"
import * as path from "path"
import * as vscode from "vscode"
import { buildApiHandler } from "../../api"
import { downloadTask } from "../../integrations/misc/export-markdown"
import { openFile, openImage } from "../../integrations/misc/open-file"
import { fetchOpenGraphData, isImageUrl } from "../../integrations/misc/link-preview"
import { selectImages } from "../../integrations/misc/process-images"
import { getTheme } from "../../integrations/theme/getTheme"
import WorkspaceTracker from "../../integrations/workspace/WorkspaceTracker"
import { ClineAccountService } from "../../services/account/ClineAccountService"
import { McpHub } from "../../services/mcp/McpHub"
import { UserInfo } from "../../shared/UserInfo"
import { ApiConfiguration, ApiProvider, ModelInfo } from "../../shared/api"
import { findLast } from "../../shared/array"
import { AutoApprovalSettings, DEFAULT_AUTO_APPROVAL_SETTINGS } from "../../shared/AutoApprovalSettings"
import { BrowserSettings, DEFAULT_BROWSER_SETTINGS } from "../../shared/BrowserSettings"
import { ChatContent } from "../../shared/ChatContent"
import { ChatSettings, DEFAULT_CHAT_SETTINGS } from "../../shared/ChatSettings"
import { ExtensionMessage, ExtensionState, Invoke, Platform } from "../../shared/ExtensionMessage"
import { HistoryItem } from "../../shared/HistoryItem"
import { McpDownloadResponse, McpMarketplaceCatalog, McpServer } from "../../shared/mcp"
import { ClineCheckpointRestore, WebviewMessage } from "../../shared/WebviewMessage"
import { fileExistsAtPath } from "../../utils/fs"
import { searchCommits } from "../../utils/git"
import { Cline } from "../Cline"
import { openMention } from "../mentions"
import { getNonce } from "./getNonce"
import { getUri } from "./getUri"
import { telemetryService } from "../../services/telemetry/TelemetryService"
import { TelemetrySetting } from "../../shared/TelemetrySetting"
import { cleanupLegacyCheckpoints } from "../../integrations/checkpoints/CheckpointMigration"
import CheckpointTracker from "../../integrations/checkpoints/CheckpointTracker"
import { getTotalTasksSize } from "../../utils/storage"
import { GlobalFileNames } from "../../global-constants"
import { setTimeout as setTimeoutPromise } from "node:timers/promises"

/*
https://github.com/microsoft/vscode-webview-ui-toolkit-samples/blob/main/default/weather-webview/src/providers/WeatherViewProvider.ts

https://github.com/KumarVariable/vscode-extension-sidebar-html/blob/master/src/customSidebarViewProvider.ts
*/

type SecretKey =
	| "apiKey"
	| "clineApiKey"
	| "openRouterApiKey"
	| "awsAccessKey"
	| "awsSecretKey"
	| "awsSessionToken"
	| "openAiApiKey"
	| "geminiApiKey"
	| "openAiNativeApiKey"
	| "deepSeekApiKey"
	| "requestyApiKey"
	| "togetherApiKey"
	| "qwenApiKey"
	| "mistralApiKey"
	| "liteLlmApiKey"
	| "authNonce"
	| "asksageApiKey"
	| "xaiApiKey"
	| "sambanovaApiKey"
type GlobalStateKey =
	| "apiProvider"
	| "apiModelId"
	| "awsRegion"
	| "awsUseCrossRegionInference"
	| "awsBedrockUsePromptCache"
	| "awsBedrockEndpoint"
	| "awsProfile"
	| "awsUseProfile"
	| "vertexProjectId"
	| "vertexRegion"
	| "lastShownAnnouncementId"
	| "customInstructions"
	| "taskHistory"
	| "openAiBaseUrl"
	| "openAiModelId"
	| "openAiModelInfo"
	| "ollamaModelId"
	| "ollamaBaseUrl"
	| "ollamaApiOptionsCtxNum"
	| "lmStudioModelId"
	| "lmStudioBaseUrl"
	| "anthropicBaseUrl"
	| "azureApiVersion"
	| "openRouterModelId"
	| "openRouterModelInfo"
	| "openRouterProviderSorting"
	| "autoApprovalSettings"
	| "browserSettings"
	| "chatSettings"
	| "vsCodeLmModelSelector"
	| "userInfo"
	| "previousModeApiProvider"
	| "previousModeModelId"
	| "previousModeThinkingBudgetTokens"
	| "previousModeVsCodeLmModelSelector"
	| "previousModeModelInfo"
	| "liteLlmBaseUrl"
	| "liteLlmModelId"
	| "qwenApiLine"
	| "requestyModelId"
	| "togetherModelId"
	| "mcpMarketplaceCatalog"
	| "telemetrySetting"
	| "asksageApiUrl"
	| "thinkingBudgetTokens"
	| "planActSeparateModelsSetting"

export class ClineProvider implements vscode.WebviewViewProvider {
	public static readonly sideBarId = "claude-dev.SidebarProvider"; // 用于 package.json 作为视图的 ID。由于 VSCode 根据其 ID 缓存视图，因此此值不能更改，更新 ID 会破坏扩展的现有实例。
	public static readonly tabPanelId = "claude-dev.TabPanelProvider";
	private static activeInstances: Set<ClineProvider> = new Set();
	private disposables: vscode.Disposable[] = [];
	private view?: vscode.WebviewView | vscode.WebviewPanel;
	private cline?: Cline;
	workspaceTracker?: WorkspaceTracker;
	mcpHub?: McpHub;
	accountService?: ClineAccountService;
	private latestAnnouncementId = "march-22-2025"; // 当我们添加新公告时更新为某个唯一标识符

	constructor(
		readonly context: vscode.ExtensionContext,
		private readonly outputChannel: vscode.OutputChannel,
	) {
		this.outputChannel.appendLine("ClineProvider 实例化");
		ClineProvider.activeInstances.add(this);
		this.workspaceTracker = new WorkspaceTracker(this);
		this.mcpHub = new McpHub(this);
		this.accountService = new ClineAccountService(this);

		// 清理遗留检查点
		cleanupLegacyCheckpoints(this.context.globalStorageUri.fsPath, this.outputChannel).catch((error) => {
			console.error("清理遗留检查点失败:", error);
		});
	}

	/*
	VSCode 扩展使用可处置模式在用户或系统关闭侧边栏/编辑器选项卡时清理资源。这适用于事件监听、命令、与 UI 交互等。
	- https://vscode-docs.readthedocs.io/en/stable/extensions/patterns-and-principles/
	- https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
	*/
	async dispose() {
		this.outputChannel.appendLine("正在处置 ClineProvider...");
		await this.clearTask();
		this.outputChannel.appendLine("已清除任务");
		if (this.view && "dispose" in this.view) {
			this.view.dispose();
			this.outputChannel.appendLine("已处置 webview");
		}
		while (this.disposables.length) {
			const x = this.disposables.pop();
			if (x) {
				x.dispose();
			}
		}
		this.workspaceTracker?.dispose();
		this.workspaceTracker = undefined;
		this.mcpHub?.dispose();
		this.mcpHub = undefined;
		this.accountService = undefined;
		this.outputChannel.appendLine("已处置所有可处置项");
		ClineProvider.activeInstances.delete(this);
	}

	// 认证方法
	async handleSignOut() {
		try {
			await this.storeSecret("clineApiKey", undefined);
			await this.updateGlobalState("apiProvider", "openrouter");
			await this.postStateToWebview();
			vscode.window.showInformationMessage("成功退出 Cline");
		} catch (error) {
			vscode.window.showErrorMessage("注销失败");
		}
	}

	async setUserInfo(info?: { displayName: string | null; email: string | null; photoURL: string | null }) {
		await this.updateGlobalState("userInfo", info);
	}

	public static getVisibleInstance(): ClineProvider | undefined {
		return findLast(Array.from(this.activeInstances), (instance) => instance.view?.visible === true);
	}

	async resolveWebviewView(webviewView: vscode.WebviewView | vscode.WebviewPanel) {
		this.outputChannel.appendLine("正在解析 webview 视图");
		this.view = webviewView;

		webviewView.webview.options = {
			// 允许在 webview 中使用脚本
			enableScripts: true,
			localResourceRoots: [this.context.extensionUri],
		};

		webviewView.webview.html =
			this.context.extensionMode === vscode.ExtensionMode.Development
				? await this.getHMRHtmlContent(webviewView.webview)
				: this.getHtmlContent(webviewView.webview);

		// 设置事件监听器以监听从 webview 视图上下文传递的消息
		// 并根据接收到的消息执行代码
		this.setWebviewMessageListener(webviewView.webview);

		// 日志显示在底部面板 > 调试控制台
		//console.log("注册监听器");

		// 监听面板何时变为可见
		// https://github.com/microsoft/vscode-discussions/discussions/840
		if ("onDidChangeViewState" in webviewView) {
			// WebviewView 和 WebviewPanel 具有所有相同的属性，除了此可见性监听器
			// 面板
			webviewView.onDidChangeViewState(
				() => {
					if (this.view?.visible) {
						this.postMessageToWebview({
							type: "action",
							action: "didBecomeVisible",
						});
					}
				},
				null,
				this.disposables,
			);
		} else if ("onDidChangeVisibility" in webviewView) {
			// 侧边栏
			webviewView.onDidChangeVisibility(
				() => {
					if (this.view?.visible) {
						this.postMessageToWebview({
							type: "action",
							action: "didBecomeVisible",
						});
					}
				},
				null,
				this.disposables,
			);
		}

		// 监听视图何时被处置
		// 当用户关闭视图或视图被程序性关闭时会发生这种情况
		webviewView.onDidDispose(
			async () => {
				await this.dispose();
			},
			null,
			this.disposables,
		);

		// 监听配置更改
		vscode.workspace.onDidChangeConfiguration(
			async (e) => {
				if (e && e.affectsConfiguration("workbench.colorTheme")) {
					// 将最新主题名称发送到 webview
					await this.postMessageToWebview({
						type: "theme",
						text: JSON.stringify(await getTheme()),
					});
				}
				if (e && e.affectsConfiguration("cline.mcpMarketplace.enabled")) {
					// 当市场选项卡设置更改时更新状态
					await this.postStateToWebview();
				}
			},
			null,
			this.disposables,
		);

		// 如果扩展正在启动新会话，则清除先前的任务状态
		this.clearTask();

		this.outputChannel.appendLine("webview 视图已解析");
	}

	async initClineWithTask(task?: string, images?: string[]) {
		await this.clearTask(); // 确保在开始新任务之前不存在现有任务，尽管这不应该是可能的，因为用户必须在开始新任务之前清除任务
		const { apiConfiguration, customInstructions, autoApprovalSettings, browserSettings, chatSettings } =
			await this.getState();
		this.cline = new Cline(
			this,
			apiConfiguration,
			autoApprovalSettings,
			browserSettings,
			chatSettings,
			customInstructions,
			task,
			images,
		);
	}

	async initClineWithHistoryItem(historyItem: HistoryItem) {
		await this.clearTask();
		const { apiConfiguration, customInstructions, autoApprovalSettings, browserSettings, chatSettings } =
			await this.getState();
		this.cline = new Cline(
			this,
			apiConfiguration,
			autoApprovalSettings,
			browserSettings,
			chatSettings,
			customInstructions,
			undefined,
			undefined,
			historyItem,
		);
	}

	// 发送任何 JSON 可序列化数据到 React 应用
	async postMessageToWebview(message: ExtensionMessage) {
		await this.view?.webview.postMessage(message);
	}

	/**
	 * 定义并返回应在 webview 面板中呈现的 HTML。
	 *
	 * @remarks 这也是创建并插入对 React webview 构建文件的引用到 webview HTML 的地方。
	 *
	 * @param webview 对扩展 webview 的引用
	 * @param extensionUri 包含扩展的目录的 URI
	 * @returns 一个模板字符串字面量，包含应在 webview 面板中呈现的 HTML
	 */
	private getHtmlContent(webview: vscode.Webview): string {
		// 获取在 webview 中运行的主脚本的本地路径，
		// 然后将其转换为我们可以在 webview 中使用的 URI。

		// 来自 React 构建输出的 CSS 文件
		const stylesUri = getUri(webview, this.context.extensionUri, ["webview-ui", "build", "assets", "index.css"]);
		// 来自 React 构建输出的 JS 文件
		const scriptUri = getUri(webview, this.context.extensionUri, ["webview-ui", "build", "assets", "index.js"]);

		// 来自 React 构建输出的 codicon 字体
		// https://github.com/microsoft/vscode-extension-samples/blob/main/webview-codicons-sample/src/extension.ts
		// 我们在扩展中安装了这个包，以便我们可以按其预期的方式访问它（字体文件可能捆绑在 vscode 中），我们只需将 CSS 文件导入到我们的 React 应用中，我们无法访问它
		// 不要忘记添加 font-src ${webview.cspSource};
		const codiconsUri = getUri(webview, this.context.extensionUri, [
			"node_modules",
			"@vscode",
			"codicons",
			"dist",
			"codicon.css",
		]);

		// const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "assets", "main.js"))

		// const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "assets", "reset.css"))
		// const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "assets", "vscode.css"))

		// // 同样适用于样式表
		// const stylesheetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "assets", "main.css"))

		// 使用 nonce 仅允许特定脚本运行。
		/*
				您 webview 的内容安全策略仅允许具有特定 nonce 的脚本
				创建内容安全策略元标记，以便仅允许加载具有 nonce 的脚本
				随着您的扩展的增长，您可能希望向 webview 添加自定义样式、字体和/或图像。如果您这样做，您需要更新内容安全策略元标记以明确允许这些资源。例如：
								<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}';">
		- 由于 vscode-webview-toolkit 的动态样式注入，样式需要 'unsafe-inline'
		- 由于我们将 base64 图像传递给 webview，因此我们需要指定 img-src ${webview.cspSource} data:;

				在元标记中我们添加 nonce 属性：一个仅使用一次的加密 nonce 以允许脚本。服务器必须在每次传输策略时生成一个唯一的 nonce 值。提供一个无法猜测的 nonce 是至关重要的，因为否则绕过资源的策略是微不足道的。
				*/
		const nonce = getNonce();

		// 提示：安装 es6-string-html VS Code 扩展以启用下面的代码高亮
		return /*html*/ `
        <!DOCTYPE html>
        <html lang="zh">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
            <meta name="theme-color" content="#000000">
            <link rel="stylesheet" type="text/css" href="${stylesUri}">
            <link href="${codiconsUri}" rel="stylesheet" />
						<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src https://*.posthog.com https://*.firebaseauth.com https://*.firebaseio.com https://*.googleapis.com https://*.firebase.com; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}' 'unsafe-eval';">
            <title>Cline</title>
          </head>
          <body>
            <noscript>您需要启用 JavaScript 才能运行此应用。</noscript>
            <div id="root"></div>
            <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
          </body>
        </html>
      `;
	}

	/**
	 * 连接到本地 Vite 开发服务器以允许 HMR，回退到捆绑的资产
	 *
	 * @param webview 对扩展 webview 的引用
	 * @returns 一个模板字符串字面量，包含应在 webview 面板中呈现的 HTML
	 */
	private async getHMRHtmlContent(webview: vscode.Webview): Promise<string> {
		const localPort = 25463;
		const localServerUrl = `localhost:${localPort}`;

		// 检查本地开发服务器是否正在运行。
		try {
			await axios.get(`http://${localServerUrl}`);
		} catch (error) {
			vscode.window.showErrorMessage(
				"Cline: 本地 webview 开发服务器未运行，HMR 将无法工作。请在启动扩展之前运行 'npm run dev:webview' 以启用 HMR。使用捆绑的资产。",
			);

			return this.getHtmlContent(webview);
		}

		const nonce = getNonce();
		const stylesUri = getUri(webview, this.context.extensionUri, ["webview-ui", "build", "assets", "index.css"]);
		const codiconsUri = getUri(webview, this.context.extensionUri, [
			"node_modules",
			"@vscode",
			"codicons",
			"dist",
			"codicon.css",
		]);

		const scriptEntrypoint = "src/main.tsx";
		const scriptUri = `http://${localServerUrl}/${scriptEntrypoint}`;

		const reactRefresh = /*html*/ `
			<script nonce="${nonce}" type="module">
				import RefreshRuntime from "http://${localServerUrl}/@react-refresh"
				RefreshRuntime.injectIntoGlobalHook(window)
				window.$RefreshReg$ = () => {}
				window.$RefreshSig$ = () => (type) => type
				window.__vite_plugin_react_preamble_installed__ = true
			</script>
		`;

		const csp = [
			"default-src 'none'",
			`font-src ${webview.cspSource}`,
			`style-src ${webview.cspSource} 'unsafe-inline' https://* http://${localServerUrl} http://0.0.0.0:${localPort}`,
			`img-src ${webview.cspSource} https: data:`,
			`script-src 'unsafe-eval' https://* http://${localServerUrl} http://0.0.0.0:${localPort} 'nonce-${nonce}'`,
			`connect-src https://* ws://${localServerUrl} ws://0.0.0.0:${localPort} http://${localServerUrl} http://0.0.0.0:${localPort}`,
		];

		return /*html*/ `
			<!DOCTYPE html>
			<html lang="zh">
				<head>
					<meta charset="utf-8">
					<meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
					<meta http-equiv="Content-Security-Policy" content="${csp.join("; ")}">
					<link rel="stylesheet" type="text/css" href="${stylesUri}">
					<link href="${codiconsUri}" rel="stylesheet" />
					<title>Cline</title>
				</head>
				<body>
					<div id="root"></div>
					${reactRefresh}
					<script type="module" src="${scriptUri}"></script>
				</body>
			</html>
		`;
	}

	/**
	 * 设置事件监听器以监听从 webview 上下文传递的消息并
	 * 根据接收到的消息执行代码。
	 *
	 * @param webview 对扩展 webview 的引用
	 */
	private setWebviewMessageListener(webview: vscode.Webview) {
		webview.onDidReceiveMessage(
			async (message: WebviewMessage) => {
				switch (message.type) {
					case "authStateChanged":
						await this.setUserInfo(message.user || undefined);
						await this.postStateToWebview();
						break;
					case "webviewDidLaunch":
						this.postStateToWebview();
						this.workspaceTracker?.populateFilePaths(); // 不等待
						getTheme().then((theme) =>
							this.postMessageToWebview({
								type: "theme",
								text: JSON.stringify(theme),
							}),
						);
						// 在调用端点失败的情况下发布最后缓存的模型
						this.readOpenRouterModels().then((openRouterModels) => {
							if (openRouterModels) {
								this.postMessageToWebview({
									type: "openRouterModels",
									openRouterModels,
								});
							}
						});
						// GUI 依赖于模型信息以保持最新，以提供最准确的定价，因此我们需要在启动时获取最新的详细信息。
						// 我们为所有用户执行此操作，因为许多用户在 API 提供者之间切换，如果他们切换回 openrouter，则会显示过时的模型信息，如果我们没有在此时检索最新信息
						// （请参见 normalizeApiConfiguration > openrouter）
						// 预取市场和 OpenRouter 模型

						this.getGlobalState("mcpMarketplaceCatalog").then((mcpMarketplaceCatalog) => {
							if (mcpMarketplaceCatalog) {
								this.postMessageToWebview({
									type: "mcpMarketplaceCatalog",
									mcpMarketplaceCatalog: mcpMarketplaceCatalog as McpMarketplaceCatalog,
								});
							}
						});
						this.silentlyRefreshMcpMarketplace();
						this.refreshOpenRouterModels().then(async (openRouterModels) => {
							if (openRouterModels) {
								// 更新状态中的模型信息（这需要在这里完成，因为我们不想在设置打开时更新状态，并且我们可能在那时刷新模型）
								const { apiConfiguration } = await this.getState();
								if (apiConfiguration.openRouterModelId) {
									await this.updateGlobalState(
										"openRouterModelInfo",
										openRouterModels[apiConfiguration.openRouterModelId],
									);
									await this.postStateToWebview();
								}
							}
						});

						// 如果用户已经选择加入遥测，则启用遥测服务
						this.getStateToPostToWebview().then((state) => {
							const { telemetrySetting } = state;
							const isOptedIn = telemetrySetting === "enabled";
							telemetryService.updateTelemetryState(isOptedIn);
						});
						break;
					case "newTask":
						// 应对 hello 消息命令时应运行的代码
						//vscode.window.showInformationMessage(message.text!)

						// 发送消息到我们的 webview。
						// 您可以发送任何 JSON 可序列化的数据。
						// 这也可以在扩展 .ts 中完成
						//this.postMessageToWebview({ type: "text", text: `Extension: ${Date.now()}` });
						// 初始化 Cline 的新实例将确保旧实例中任何正在运行的承诺不会影响我们的新任务。这本质上为新任务创建了一个全新的状态
						await this.initClineWithTask(message.text, message.images);
						break;
					case "apiConfiguration":
						if (message.apiConfiguration) {
							await this.updateApiConfiguration(message.apiConfiguration);
						}
						await this.postStateToWebview();
						break;
					case "autoApprovalSettings":
						if (message.autoApprovalSettings) {
							await this.updateGlobalState("autoApprovalSettings", message.autoApprovalSettings);
							if (this.cline) {
								this.cline.autoApprovalSettings = message.autoApprovalSettings;
							}
							await this.postStateToWebview();
						}
						break;
					case "browserSettings":
						if (message.browserSettings) {
							await this.updateGlobalState("browserSettings", message.browserSettings);
							if (this.cline) {
								this.cline.updateBrowserSettings(message.browserSettings);
							}
							await this.postStateToWebview();
						}
						break;
					case "togglePlanActMode":
						if (message.chatSettings) {
							await this.togglePlanActModeWithChatSettings(message.chatSettings, message.chatContent);
						}
						break;
					case "optionsResponse":
						await this.postMessageToWebview({
							type: "invoke",
							invoke: "sendMessage",
							text: message.text,
						});
						break;
					// case "relaunchChromeDebugMode":
					// 	if (this.cline) {
					// 		this.cline.browserSession.relaunchChromeDebugMode();
					// 	}
					// 	break;
					case "askResponse":
						this.cline?.handleWebviewAskResponse(message.askResponse!, message.text, message.images);
						break;
					case "clearTask":
						// newTask 将使用给定的任务文本启动新任务，而 clear task 将重置当前会话并允许启动新任务
						await this.clearTask();
						await this.postStateToWebview();
						break;
					case "didShowAnnouncement":
						await this.updateGlobalState("lastShownAnnouncementId", this.latestAnnouncementId);
						await this.postStateToWebview();
						break;
					case "selectImages":
						const images = await selectImages();
						await this.postMessageToWebview({
							type: "selectedImages",
							images,
						});
						break;
					case "exportCurrentTask":
						const currentTaskId = this.cline?.taskId;
						if (currentTaskId) {
							this.exportTaskWithId(currentTaskId);
						}
						break;
					case "showTaskWithId":
						this.showTaskWithId(message.text!);
						break;
					case "deleteTaskWithId":
						this.deleteTaskWithId(message.text!);
						break;
					case "exportTaskWithId":
						this.exportTaskWithId(message.text!);
						break;
					case "resetState":
						await this.resetState();
						break;
					case "requestOllamaModels":
						const ollamaModels = await this.getOllamaModels(message.text);
						this.postMessageToWebview({
							type: "ollamaModels",
							ollamaModels,
						});
						break;
					case "requestLmStudioModels":
						const lmStudioModels = await this.getLmStudioModels(message.text);
						this.postMessageToWebview({
							type: "lmStudioModels",
							lmStudioModels,
						});
						break;
					case "requestVsCodeLmModels":
						const vsCodeLmModels = await this.getVsCodeLmModels();
						this.postMessageToWebview({ type: "vsCodeLmModels", vsCodeLmModels });
						break;
					case "refreshOpenRouterModels":
						await this.refreshOpenRouterModels();
						break;
					case "refreshOpenAiModels":
						const { apiConfiguration } = await this.getState();
						const openAiModels = await this.getOpenAiModels(
							apiConfiguration.openAiBaseUrl,
							apiConfiguration.openAiApiKey,
						);
						this.postMessageToWebview({ type: "openAiModels", openAiModels });
						break;
					case "openImage":
						openImage(message.text!);
						break;
					case "openInBrowser":
						if (message.url) {
							vscode.env.openExternal(vscode.Uri.parse(message.url));
						}
						break;
					case "fetchOpenGraphData":
						this.fetchOpenGraphData(message.text!);
						break;
					case "checkIsImageUrl":
						this.checkIsImageUrl(message.text!);
						break;
					case "openFile":
						openFile(message.text!);
						break;
					case "openMention":
						openMention(message.text);
						break;
					case "checkpointDiff": {
						if (message.number) {
							await this.cline?.presentMultifileDiff(message.number, false);
						}
						break;
					}
					case "checkpointRestore": {
						await this.cancelTask(); // 我们不能在任务处于活动状态时更改消息历史，因为这可能会在编辑文件或运行命令的过程中，期望响应请求而不是被新消息取代，例如添加 deleted_api_reqs
						// 取消任务等待任何打开的编辑器被还原并启动一个新的 cline 实例
						if (message.number) {
							// 等待消息加载
							await pWaitFor(() => this.cline?.isInitialized === true, {
								timeout: 3_000,
							}).catch(() => {
								console.error("初始化新 cline 实例失败");
							});
							// 注意：cancelTask 等待 abortTask，abortTask 等待 diffViewProvider.revertChanges，revertChanges 允许我们重置到检查点，而不是在检查点重置的同时或之后调用 revertChanges 函数
							await this.cline?.restoreCheckpoint(message.number, message.text! as ClineCheckpointRestore);
						}
						break;
					}
					case "taskCompletionViewChanges": {
						if (message.number) {
							await this.cline?.presentMultifileDiff(message.number, true);
						}
						break;
					}
					case "cancelTask":
						this.cancelTask();
						break;
					case "getLatestState":
						await this.postStateToWebview();
						break;
					case "accountLoginClicked": {
						// 生成用于状态验证的 nonce
						const nonce = crypto.randomBytes(32).toString("hex");
						await this.storeSecret("authNonce", nonce);

						// 打开浏览器进行带状态参数的身份验证
						console.log("在账户页面点击登录按钮");
						console.log("使用状态参数打开身份验证页面");

						const uriScheme = vscode.env.uriScheme;

						const authUrl = vscode.Uri.parse(
							`https://app.cline.bot/auth?state=${encodeURIComponent(nonce)}&callback_url=${encodeURIComponent(`${uriScheme || "vscode"}://saoudrizwan.claude-dev/auth`)}`,
						);
						vscode.env.openExternal(authUrl);
						break;
					}
					case "accountLogoutClicked": {
						await this.handleSignOut();
						break;
					}
					case "showAccountViewClicked": {
						await this.postMessageToWebview({ type: "action", action: "accountButtonClicked" });
						break;
					}
					case "fetchUserCreditsData": {
						await this.fetchUserCreditsData();
						break;
					}
					case "showMcpView": {
						await this.postMessageToWebview({ type: "action", action: "mcpButtonClicked" });
						break;
					}
					case "openMcpSettings": {
						const mcpSettingsFilePath = await this.mcpHub?.getMcpSettingsFilePath();
						if (mcpSettingsFilePath) {
							openFile(mcpSettingsFilePath);
						}
						break;
					}
					case "fetchMcpMarketplace": {
						await this.fetchMcpMarketplace(message.bool);
						break;
					}
					case "downloadMcp": {
						if (message.mcpId) {
							// 1. 如果我们处于计划模式，则切换到行动模式
							const { chatSettings } = await this.getStateToPostToWebview();
							if (chatSettings.mode === "plan") {
								await this.togglePlanActModeWithChatSettings({ mode: "act" });
							}

							// 2. 如果禁用，则启用 MCP 设置
							// 如果禁用，则启用 MCP 模式
							const mcpConfig = vscode.workspace.getConfiguration("cline.mcp");
							if (mcpConfig.get<string>("mode") !== "full") {
								await mcpConfig.update("mode", "full", true);
							}

							// 3. 下载 MCP
							await this.downloadMcp(message.mcpId);
						}
						break;
					}
					case "silentlyRefreshMcpMarketplace": {
						await this.silentlyRefreshMcpMarketplace();
						break;
					}
					// case "openMcpMarketplaceServerDetails": {
					// 	if (message.text) {
					// 		const response = await fetch(`https://api.cline.bot/v1/mcp/marketplace/item?mcpId=${message.mcpId}`);
					// 		const details: McpDownloadResponse = await response.json();

					// 		if (details.readmeContent) {
					// 			// 禁用 markdown 预览标记
					// 			const config = vscode.workspace.getConfiguration("markdown");
					// 			await config.update("preview.markEditorSelection", false, true);

					// 			// 创建带有 base64 编码的 markdown 内容的 URI
					// 			const uri = vscode.Uri.parse(
					// 				`${DIFF_VIEW_URI_SCHEME}:${details.name} README?${Buffer.from(details.readmeContent).toString("base64")}`,
					// 			);

					// 			// 关闭现有
					// 			const tabs = vscode.window.tabGroups.all
					// 				.flatMap((tg) => tg.tabs)
					// 				.filter((tab) => tab.label && tab.label.includes("README") && tab.label.includes("Preview"));
					// 			for (const tab of tabs) {
					// 				await vscode.window.tabGroups.close(tab);
					// 			}

					// 			// 仅显示预览
					// 			await vscode.commands.executeCommand("markdown.showPreview", uri, {
					// 				sideBySide: true,
					// 				preserveFocus: true,
					// 			});
					// 		}
					// 	}

					// 	this.postMessageToWebview({ type: "relinquishControl" });

					// 	break;
					// }
					case "toggleMcpServer": {
						try {
							await this.mcpHub?.toggleServerDisabled(message.serverName!, message.disabled!);
						} catch (error) {
							console.error(`切换 MCP 服务器 ${message.serverName} 失败:`, error);
						}
						break;
					}
					case "toggleToolAutoApprove": {
						try {
							await this.mcpHub?.toggleToolAutoApprove(message.serverName!, message.toolName!, message.autoApprove!);
						} catch (error) {
							console.error(`切换工具 ${message.toolName} 的自动批准失败:`, error);
						}
						break;
					}
					case "requestTotalTasksSize": {
						this.refreshTotalTasksSize();
						break;
					}
					case "restartMcpServer": {
						try {
							await this.mcpHub?.restartConnection(message.text!);
						} catch (error) {
							console.error(`重试连接 ${message.text} 失败:`, error);
						}
						break;
					}
					case "deleteMcpServer": {
						if (message.serverName) {
							this.mcpHub?.deleteServer(message.serverName);
						}
						break;
					}
					case "fetchLatestMcpServersFromHub": {
						this.mcpHub?.sendLatestMcpServers();
						break;
					}
					case "searchCommits": {
						const cwd = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).at(0);
						if (cwd) {
							try {
								const commits = await searchCommits(message.text || "", cwd);
								await this.postMessageToWebview({
									type: "commitSearchResults",
									commits,
								});
							} catch (error) {
								console.error(`搜索提交时出错: ${JSON.stringify(error)}`);
							}
						}
						break;
					}
					case "updateMcpTimeout": {
						try {
							if (message.serverName && message.timeout) {
								await this.mcpHub?.updateServerTimeout(message.serverName, message.timeout);
							}
						} catch (error) {
							console.error(`更新服务器 ${message.serverName} 的超时失败:`, error);
						}
						break;
					}
					case "openExtensionSettings": {
						const settingsFilter = message.text || "";
						await vscode.commands.executeCommand(
							"workbench.action.openSettings",
							`@ext:saoudrizwan.claude-dev ${settingsFilter}`.trim(), // 如果没有设置过滤器，则修剪空格
						);
						break;
					}
					case "invoke": {
						if (message.text) {
							await this.postMessageToWebview({
								type: "invoke",
								invoke: message.text as Invoke,
							});
						}
						break;
					}
					// 遥测
					case "openSettings": {
						await this.postMessageToWebview({
							type: "action",
							action: "settingsButtonClicked",
						});
						break;
					}
					case "telemetrySetting": {
						if (message.telemetrySetting) {
							await this.updateTelemetrySetting(message.telemetrySetting);
						}
						await this.postStateToWebview();
						break;
					}
					case "updateSettings": {
						// API 配置
						if (message.apiConfiguration) {
							await this.updateApiConfiguration(message.apiConfiguration);
						}

						// 自定义说明
						await this.updateCustomInstructions(message.customInstructionsSetting);

						// 遥测设置
						if (message.telemetrySetting) {
							await this.updateTelemetrySetting(message.telemetrySetting);
						}

						// 计划行动设置
						await this.updateGlobalState("planActSeparateModelsSetting", message.planActSeparateModelsSetting);

						// 更新设置后，将状态发布到 webview
						await this.postStateToWebview();

						await this.postMessageToWebview({ type: "didUpdateSettings" });
						break;
					}
					case "clearAllTaskHistory": {
						await this.deleteAllTaskHistory();
						await this.postStateToWebview();
						this.refreshTotalTasksSize();
						this.postMessageToWebview({ type: "relinquishControl" });
						break;
					}
					// 在这里添加更多 switch case 语句，因为在 webview 上下文中创建了更多 webview 消息命令
					// （即在 media/main.js 中）
				}
			},
			null,
			this.disposables,
		);
	}

	async updateTelemetrySetting(telemetrySetting: TelemetrySetting) {
		await this.updateGlobalState("telemetrySetting", telemetrySetting);
		const isOptedIn = telemetrySetting === "enabled";
		telemetryService.updateTelemetryState(isOptedIn);
	}

	async togglePlanActModeWithChatSettings(chatSettings: ChatSettings, chatContent?: ChatContent) {
		const didSwitchToActMode = chatSettings.mode === "act";

		// 捕获模式切换遥测 | 无论我们是否知道 taskId 都要捕获
		telemetryService.captureModeSwitch(this.cline?.taskId ?? "0", chatSettings.mode);

		// 获取我们将在保存当前模式 API 信息后恢复的先前模型信息
		const {
			apiConfiguration,
			previousModeApiProvider: newApiProvider,
			previousModeModelId: newModelId,
			previousModeModelInfo: newModelInfo,
			previousModeVsCodeLmModelSelector: newVsCodeLmModelSelector,
			previousModeThinkingBudgetTokens: newThinkingBudgetTokens,
			planActSeparateModelsSetting,
		} = await this.getState();

		const shouldSwitchModel = planActSeparateModelsSetting === true;

		if (shouldSwitchModel) {
			// 保存此模式下使用的最后模型
			await this.updateGlobalState("previousModeApiProvider", apiConfiguration.apiProvider);
			await this.updateGlobalState("previousModeThinkingBudgetTokens", apiConfiguration.thinkingBudgetTokens);
			switch (apiConfiguration.apiProvider) {
				case "anthropic":
				case "bedrock":
				case "vertex":
				case "gemini":
				case "asksage":
				case "openai-native":
				case "qwen":
				case "deepseek":
					await this.updateGlobalState("previousModeModelId", apiConfiguration.apiModelId);
					break;
				case "openrouter":
				case "cline":
					await this.updateGlobalState("previousModeModelId", apiConfiguration.openRouterModelId);
					await this.updateGlobalState("previousModeModelInfo", apiConfiguration.openRouterModelInfo);
					break;
				case "vscode-lm":
					// 重要的是我们不将 modelId 设置为此，因为它是对象而不是字符串（webview 期望模型 ID 为字符串）
					await this.updateGlobalState("previousModeVsCodeLmModelSelector", apiConfiguration.vsCodeLmModelSelector);
					break;
				case "openai":
					await this.updateGlobalState("previousModeModelId", apiConfiguration.openAiModelId);
					await this.updateGlobalState("previousModeModelInfo", apiConfiguration.openAiModelInfo);
					break;
				case "ollama":
					await this.updateGlobalState("previousModeModelId", apiConfiguration.ollamaModelId);
					break;
				case "lmstudio":
					await this.updateGlobalState("previousModeModelId", apiConfiguration.lmStudioModelId);
					break;
				case "litellm":
					await this.updateGlobalState("previousModeModelId", apiConfiguration.liteLlmModelId);
					break;
				case "requesty":
					await this.updateGlobalState("previousModeModelId", apiConfiguration.requestyModelId);
					break;
			}

			// 恢复先前模式中使用的模型
			if (newApiProvider || newModelId || newThinkingBudgetTokens !== undefined || newVsCodeLmModelSelector) {
				await this.updateGlobalState("apiProvider", newApiProvider);
				await this.updateGlobalState("thinkingBudgetTokens", newThinkingBudgetTokens);
				switch (newApiProvider) {
					case "anthropic":
					case "bedrock":
					case "vertex":
					case "gemini":
					case "asksage":
					case "openai-native":
					case "qwen":
					case "deepseek":
						await this.updateGlobalState("apiModelId", newModelId);
						break;
					case "openrouter":
					case "cline":
						await this.updateGlobalState("openRouterModelId", newModelId);
						await this.updateGlobalState("openRouterModelInfo", newModelInfo);
						break;
					case "vscode-lm":
						await this.updateGlobalState("vsCodeLmModelSelector", newVsCodeLmModelSelector);
						break;
					case "openai":
						await this.updateGlobalState("openAiModelId", newModelId);
						await this.updateGlobalState("openAiModelInfo", newModelInfo);
						break;
					case "ollama":
						await this.updateGlobalState("ollamaModelId", newModelId);
						break;
					case "lmstudio":
						await this.updateGlobalState("lmStudioModelId", newModelId);
						break;
					case "litellm":
						await this.updateGlobalState("liteLlmModelId", newModelId);
						break;
					case "requesty":
						await this.updateGlobalState("requestyModelId", newModelId);
						break;
				}

				if (this.cline) {
					const { apiConfiguration: updatedApiConfiguration } = await this.getState();
					this.cline.api = buildApiHandler(updatedApiConfiguration);
				}
			}
		}

		await this.updateGlobalState("chatSettings", chatSettings);
		await this.postStateToWebview();

		if (this.cline) {
			this.cline.updateChatSettings(chatSettings);
			if (this.cline.isAwaitingPlanResponse && didSwitchToActMode) {
				this.cline.didRespondToPlanAskBySwitchingMode = true;
				// 如果提供了 chatContent，则使用它，否则使用默认消息
				await this.postMessageToWebview({
					type: "invoke",
					invoke: "sendMessage",
					text: chatContent?.message || "PLAN_MODE_TOGGLE_RESPONSE",
					images: chatContent?.images,
				});
			} else {
				this.cancelTask();
			}
		}
	}

	async cancelTask() {
		if (this.cline) {
			const { historyItem } = await this.getTaskWithId(this.cline.taskId)
			try {
				await this.cline.abortTask()
			} catch (error) {
				console.error("任务中止失败", error)
			}
			await pWaitFor(
				() =>
					this.cline === undefined ||
					this.cline.isStreaming === false ||
					this.cline.didFinishAbortingStream ||
					this.cline.isWaitingForFirstChunk, // 如果只处理了第一个块，则无需等待优雅中止（关闭编辑、浏览器等）
				{
					timeout: 3_000,
				},
			).catch(() => {
				console.error("任务中止失败")
			})
			if (this.cline) {
				// 'abandoned' 将防止此 cline 实例影响未来的 cline 实例 GUI。这可能发生在其挂起于流请求时
				this.cline.abandoned = true
			}
			await this.initClineWithHistoryItem(historyItem) // 再次清除任务，因此我们需要在上面手动中止任务
			// await this.postStateToWebview() // 新的 Cline 实例将在准备好时发布状态。将其放在这里会导致向 webview 发送空消息数组，导致 virtuoso 必须重新加载整个列表
		}
	}

	async updateCustomInstructions(instructions?: string) {
		// 用户可能在清空字段
		await this.updateGlobalState("customInstructions", instructions || undefined)
		if (this.cline) {
			this.cline.customInstructions = instructions || undefined
		}
	}

	async updateApiConfiguration(apiConfiguration: ApiConfiguration) {
		const {
			apiProvider,
			apiModelId,
			apiKey,
			openRouterApiKey,
			awsAccessKey,
			awsSecretKey,
			awsSessionToken,
			awsRegion,
			awsUseCrossRegionInference,
			awsBedrockUsePromptCache,
			awsBedrockEndpoint,
			awsProfile,
			awsUseProfile,
			vertexProjectId,
			vertexRegion,
			openAiBaseUrl,
			openAiApiKey,
			openAiModelId,
			openAiModelInfo,
			ollamaModelId,
			ollamaBaseUrl,
			ollamaApiOptionsCtxNum,
			lmStudioModelId,
			lmStudioBaseUrl,
			anthropicBaseUrl,
			geminiApiKey,
			openAiNativeApiKey,
			deepSeekApiKey,
			requestyApiKey,
			requestyModelId,
			togetherApiKey,
			togetherModelId,
			qwenApiKey,
			mistralApiKey,
			azureApiVersion,
			openRouterModelId,
			openRouterModelInfo,
			openRouterProviderSorting,
			vsCodeLmModelSelector,
			liteLlmBaseUrl,
			liteLlmModelId,
			liteLlmApiKey,
			qwenApiLine,
			asksageApiKey,
			asksageApiUrl,
			xaiApiKey,
			thinkingBudgetTokens,
			clineApiKey,
			sambanovaApiKey,
		} = apiConfiguration
		await this.updateGlobalState("apiProvider", apiProvider)
		await this.updateGlobalState("apiModelId", apiModelId)
		await this.storeSecret("apiKey", apiKey)
		await this.storeSecret("openRouterApiKey", openRouterApiKey)
		await this.storeSecret("awsAccessKey", awsAccessKey)
		await this.storeSecret("awsSecretKey", awsSecretKey)
		await this.storeSecret("awsSessionToken", awsSessionToken)
		await this.updateGlobalState("awsRegion", awsRegion)
		await this.updateGlobalState("awsUseCrossRegionInference", awsUseCrossRegionInference)
		await this.updateGlobalState("awsBedrockUsePromptCache", awsBedrockUsePromptCache)
		await this.updateGlobalState("awsBedrockEndpoint", awsBedrockEndpoint)
		await this.updateGlobalState("awsProfile", awsProfile)
		await this.updateGlobalState("awsUseProfile", awsUseProfile)
		await this.updateGlobalState("vertexProjectId", vertexProjectId)
		await this.updateGlobalState("vertexRegion", vertexRegion)
		await this.updateGlobalState("openAiBaseUrl", openAiBaseUrl)
		await this.storeSecret("openAiApiKey", openAiApiKey)
		await this.updateGlobalState("openAiModelId", openAiModelId)
		await this.updateGlobalState("openAiModelInfo", openAiModelInfo)
		await this.updateGlobalState("ollamaModelId", ollamaModelId)
		await this.updateGlobalState("ollamaBaseUrl", ollamaBaseUrl)
		await this.updateGlobalState("ollamaApiOptionsCtxNum", ollamaApiOptionsCtxNum)
		await this.updateGlobalState("lmStudioModelId", lmStudioModelId)
		await this.updateGlobalState("lmStudioBaseUrl", lmStudioBaseUrl)
		await this.updateGlobalState("anthropicBaseUrl", anthropicBaseUrl)
		await this.storeSecret("geminiApiKey", geminiApiKey)
		await this.storeSecret("openAiNativeApiKey", openAiNativeApiKey)
		await this.storeSecret("deepSeekApiKey", deepSeekApiKey)
		await this.storeSecret("requestyApiKey", requestyApiKey)
		await this.storeSecret("togetherApiKey", togetherApiKey)
		await this.storeSecret("qwenApiKey", qwenApiKey)
		await this.storeSecret("mistralApiKey", mistralApiKey)
		await this.storeSecret("liteLlmApiKey", liteLlmApiKey)
		await this.storeSecret("xaiApiKey", xaiApiKey)
		await this.updateGlobalState("azureApiVersion", azureApiVersion)
		await this.updateGlobalState("openRouterModelId", openRouterModelId)
		await this.updateGlobalState("openRouterModelInfo", openRouterModelInfo)
		await this.updateGlobalState("openRouterProviderSorting", openRouterProviderSorting)
		await this.updateGlobalState("vsCodeLmModelSelector", vsCodeLmModelSelector)
		await this.updateGlobalState("liteLlmBaseUrl", liteLlmBaseUrl)
		await this.updateGlobalState("liteLlmModelId", liteLlmModelId)
		await this.updateGlobalState("qwenApiLine", qwenApiLine)
		await this.updateGlobalState("requestyModelId", requestyModelId)
		await this.updateGlobalState("togetherModelId", togetherModelId)
		await this.storeSecret("asksageApiKey", asksageApiKey)
		await this.updateGlobalState("asksageApiUrl", asksageApiUrl)
		await this.updateGlobalState("thinkingBudgetTokens", thinkingBudgetTokens)
		await this.storeSecret("clineApiKey", clineApiKey)
		await this.storeSecret("sambanovaApiKey", sambanovaApiKey)
		if (this.cline) {
			this.cline.api = buildApiHandler(apiConfiguration)
		}
	}

	// MCP

	async getDocumentsPath(): Promise<string> {
		if (process.platform === "win32") {
			try {
				const { stdout: docsPath } = await execa("powershell", [
					"-NoProfile", // 忽略用户的 PowerShell 配置文件
					"-Command",
					"[System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::MyDocuments)",
				])
				const trimmedPath = docsPath.trim()
				if (trimmedPath) {
					return trimmedPath
				}
			} catch (err) {
				console.error("无法获取 Windows 文档路径。回退到 homedir/Documents。")
			}
		} else if (process.platform === "linux") {
			try {
				// 首先检查 xdg-user-dir 是否存在
				await execa("which", ["xdg-user-dir"])

				// 如果存在，尝试获取 XDG 文档路径
				const { stdout } = await execa("xdg-user-dir", ["DOCUMENTS"])
				const trimmedPath = stdout.trim()
				if (trimmedPath) {
					return trimmedPath
				}
			} catch {
				// 记录错误但继续回退
				console.error("无法获取 XDG 文档路径。回退到 homedir/Documents。")
			}
		}

		// 所有平台的默认回退
		return path.join(os.homedir(), "Documents")
	}

	async ensureMcpServersDirectoryExists(): Promise<string> {
		const userDocumentsPath = await this.getDocumentsPath()
		const mcpServersDir = path.join(userDocumentsPath, "Cline", "MCP")
		try {
			await fs.mkdir(mcpServersDir, { recursive: true })
		} catch (error) {
			return "~/Documents/Cline/MCP" // 如果在文档中创建目录失败，返回此路径（例如权限问题） - 这个路径只在系统提示中使用
		}
		return mcpServersDir
	}

	async ensureSettingsDirectoryExists(): Promise<string> {
		const settingsDir = path.join(this.context.globalStorageUri.fsPath, "settings")
		await fs.mkdir(settingsDir, { recursive: true })
		return settingsDir
	}

	// VSCode LM API

	private async getVsCodeLmModels() {
		try {
			const models = await vscode.lm.selectChatModels({})
			return models || []
		} catch (error) {
			console.error("获取 VS Code LM 模型时出错:", error)
			return []
		}
	}

	// Ollama

	async getOllamaModels(baseUrl?: string) {
		try {
			if (!baseUrl) {
				baseUrl = "http://localhost:11434"
			}
			if (!URL.canParse(baseUrl)) {
				return []
			}
			const response = await axios.get(`${baseUrl}/api/tags`)
			const modelsArray = response.data?.models?.map((model: any) => model.name) || []
			const models = [...new Set<string>(modelsArray)]
			return models
		} catch (error) {
			return []
		}
	}

	// LM Studio

	async getLmStudioModels(baseUrl?: string) {
		try {
			if (!baseUrl) {
				baseUrl = "http://localhost:1234"
			}
			if (!URL.canParse(baseUrl)) {
				return []
			}
			const response = await axios.get(`${baseUrl}/v1/models`)
			const modelsArray = response.data?.data?.map((model: any) => model.id) || []
			const models = [...new Set<string>(modelsArray)]
			return models
		} catch (error) {
			return []
		}
	}

	// Account

	async fetchUserCreditsData() {
		try {
			await Promise.all([
				this.accountService?.fetchBalance(),
				this.accountService?.fetchUsageTransactions(),
				this.accountService?.fetchPaymentTransactions(),
			])
		} catch (error) {
			console.error("获取用户信用数据失败:", error)
		}
	}

	// Auth

	public async validateAuthState(state: string | null): Promise<boolean> {
		const storedNonce = await this.getSecret("authNonce")
		if (!state || state !== storedNonce) {
			return false
		}
		await this.storeSecret("authNonce", undefined) // 使用后清除
		return true
	}

	async handleAuthCallback(customToken: string, apiKey: string) {
		try {
			// 存储 API 密钥以供 API 调用
			await this.storeSecret("clineApiKey", apiKey)

			// 发送自定义令牌到 webview 进行 Firebase 身份验证
			await this.postMessageToWebview({
				type: "authCallback",
				customToken,
			})

			const clineProvider: ApiProvider = "cline"
			await this.updateGlobalState("apiProvider", clineProvider)

			// 使用新提供者和 API 密钥更新 API 配置
			const { apiConfiguration } = await this.getState()
			const updatedConfig = {
				...apiConfiguration,
				apiProvider: clineProvider,
				clineApiKey: apiKey,
			}

			if (this.cline) {
				this.cline.api = buildApiHandler(updatedConfig)
			}

			await this.postStateToWebview()
			// vscode.window.showInformationMessage("成功登录到 Cline")
		} catch (error) {
			console.error("处理身份验证回调失败:", error)
			vscode.window.showErrorMessage("登录 Cline 失败")
			// 即使在登录失败时，我们也保留任何现有的令牌
			// 仅在明确注销时清除令牌
		}
	}

	// MCP Marketplace

	private async fetchMcpMarketplaceFromApi(silent: boolean = false): Promise<McpMarketplaceCatalog | undefined> {
		try {
			const response = await axios.get("https://api.cline.bot/v1/mcp/marketplace", {
				headers: {
					"Content-Type": "application/json",
				},
			})

			if (!response.data) {
				throw new Error("MCP 市场 API 返回无效响应")
			}

			const catalog: McpMarketplaceCatalog = {
				items: (response.data || []).map((item: any) => ({
					...item,
					githubStars: item.githubStars ?? 0,
					downloadCount: item.downloadCount ?? 0,
					tags: item.tags ?? [],
				})),
			}

			// 存储在全局状态中
			await this.updateGlobalState("mcpMarketplaceCatalog", catalog)
			return catalog
		} catch (error) {
			console.error("获取 MCP 市场失败:", error)
			if (!silent) {
				const errorMessage = error instanceof Error ? error.message : "获取 MCP 市场失败"
				await this.postMessageToWebview({
					type: "mcpMarketplaceCatalog",
					error: errorMessage,
				})
				vscode.window.showErrorMessage(errorMessage)
			}
			return undefined
		}
	}

	async silentlyRefreshMcpMarketplace() {
		try {
			const catalog = await this.fetchMcpMarketplaceFromApi(true)
			if (catalog) {
				await this.postMessageToWebview({
					type: "mcpMarketplaceCatalog",
					mcpMarketplaceCatalog: catalog,
				})
			}
		} catch (error) {
			console.error("静默刷新 MCP 市场失败:", error)
		}
	}

	private async fetchMcpMarketplace(forceRefresh: boolean = false) {
		try {
			// 检查是否有缓存数据
			const cachedCatalog = (await this.getGlobalState("mcpMarketplaceCatalog")) as McpMarketplaceCatalog | undefined
			if (!forceRefresh && cachedCatalog?.items) {
				await this.postMessageToWebview({
					type: "mcpMarketplaceCatalog",
					mcpMarketplaceCatalog: cachedCatalog,
				})
				return
			}

			const catalog = await this.fetchMcpMarketplaceFromApi(false)
			if (catalog) {
				await this.postMessageToWebview({
					type: "mcpMarketplaceCatalog",
					mcpMarketplaceCatalog: catalog,
				})
			}
		} catch (error) {
			console.error("处理缓存的 MCP 市场失败:", error)
			const errorMessage = error instanceof Error ? error.message : "处理缓存的 MCP 市场失败"
			await this.postMessageToWebview({
				type: "mcpMarketplaceCatalog",
				error: errorMessage,
			})
			vscode.window.showErrorMessage(errorMessage)
		}
	}

	private async downloadMcp(mcpId: string) {
		try {
			// 首先检查我们是否已经安装了这个 MCP 服务器
			const servers = this.mcpHub?.getServers() || []
			const isInstalled = servers.some((server: McpServer) => server.name === mcpId)

			if (isInstalled) {
				throw new Error("此 MCP 服务器已安装")
			}

			// 从市场获取服务器详细信息
			const response = await axios.post<McpDownloadResponse>(
				"https://api.cline.bot/v1/mcp/download",
				{ mcpId },
				{
					headers: { "Content-Type": "application/json" },
					timeout: 10000,
				},
			)

			if (!response.data) {
				throw new Error("MCP 市场 API 返回无效响应")
			}

			console.log("[downloadMcp] 下载 API 的响应", { response })

			const mcpDetails = response.data

			// 验证必需字段
			if (!mcpDetails.githubUrl) {
				throw new Error("MCP 下载响应中缺少 GitHub URL")
			}
			if (!mcpDetails.readmeContent) {
				throw new Error("MCP 下载响应中缺少 README 内容")
			}

			// 发送详细信息到 webview
			await this.postMessageToWebview({
				type: "mcpDownloadDetails",
				mcpDownloadDetails: mcpDetails,
			})

			// 创建任务，包含 README 的上下文和 MCP 服务器安装的附加指南
			const task = `从 ${mcpDetails.githubUrl} 设置 MCP 服务器，同时遵循以下 MCP 服务器安装规则：
- 在 cline_mcp_settings.json 中使用 "${mcpDetails.mcpId}" 作为服务器名称。
- 在开始安装之前创建新 MCP 服务器的目录。
- 使用与用户的 shell 和操作系统最佳实践一致的命令。
- 以下 README 可能包含与用户的操作系统冲突的说明，在这种情况下请谨慎进行。
- 安装后，通过使用其工具展示服务器的能力。
以下是项目的 README，帮助您入门:\n\n${mcpDetails.readmeContent}\n${mcpDetails.llmsInstallationContent}`

			// 初始化任务并显示聊天视图
			await this.initClineWithTask(task)
			await this.postMessageToWebview({
				type: "action",
				action: "chatButtonClicked",
			})
		} catch (error) {
			console.error("下载 MCP 失败:", error)
			let errorMessage = "下载 MCP 失败"

			if (axios.isAxiosError(error)) {
				if (error.code === "ECONNABORTED") {
					errorMessage = "请求超时。请再试一次。"
				} else if (error.response?.status === 404) {
					errorMessage = "市场中未找到 MCP 服务器。"
				} else if (error.response?.status === 500) {
					errorMessage = "内部服务器错误。请稍后再试。"
				} else if (!error.response && error.request) {
					errorMessage = "网络错误。请检查您的互联网连接。"
				}
			} else if (error instanceof Error) {
				errorMessage = error.message
			}

			// 在通知和市场 UI 中显示错误
			vscode.window.showErrorMessage(errorMessage)
			await this.postMessageToWebview({
				type: "mcpDownloadDetails",
				error: errorMessage,
			})
		}
	}

	// OpenAi

	async getOpenAiModels(baseUrl?: string, apiKey?: string) {
		try {
			if (!baseUrl) {
				return []
			}

			if (!URL.canParse(baseUrl)) {
				return []
			}

			const config: Record<string, any> = {}
			if (apiKey) {
				config["headers"] = { Authorization: `Bearer ${apiKey}` }
			}

			const response = await axios.get(`${baseUrl}/models`, config)
			const modelsArray = response.data?.data?.map((model: any) => model.id) || []
			const models = [...new Set<string>(modelsArray)]
			return models
		} catch (error) {
			return []
		}
	}

	// OpenRouter

	async handleOpenRouterCallback(code: string) {
		let apiKey: string
		try {
			const response = await axios.post("https://openrouter.ai/api/v1/auth/keys", { code })
			if (response.data && response.data.key) {
				apiKey = response.data.key
			} else {
				throw new Error("OpenRouter API 返回无效响应")
			}
		} catch (error) {
			console.error("交换代码以获取 API 密钥时出错:", error)
			throw error
		}

		const openrouter: ApiProvider = "openrouter"
		await this.updateGlobalState("apiProvider", openrouter)
		await this.storeSecret("openRouterApiKey", apiKey)
		await this.postStateToWebview()
		if (this.cline) {
			this.cline.api = buildApiHandler({
				apiProvider: openrouter,
				openRouterApiKey: apiKey,
			})
		}
		// await this.postMessageToWebview({ type: "action", action: "settingsButtonClicked" }) // 如果用户在欢迎界面，用户体验不佳
	}

	private async ensureCacheDirectoryExists(): Promise<string> {
		const cacheDir = path.join(this.context.globalStorageUri.fsPath, "cache")
		await fs.mkdir(cacheDir, { recursive: true })
		return cacheDir
	}

	async readOpenRouterModels(): Promise<Record<string, ModelInfo> | undefined> {
		const openRouterModelsFilePath = path.join(await this.ensureCacheDirectoryExists(), GlobalFileNames.openRouterModels)
		const fileExists = await fileExistsAtPath(openRouterModelsFilePath)
		if (fileExists) {
			const fileContents = await fs.readFile(openRouterModelsFilePath, "utf8")
			return JSON.parse(fileContents)
		}
		return undefined
	}

	async refreshOpenRouterModels() {
		const openRouterModelsFilePath = path.join(await this.ensureCacheDirectoryExists(), GlobalFileNames.openRouterModels)

		let models: Record<string, ModelInfo> = {}
		try {
			const response = await axios.get("https://openrouter.ai/api/v1/models")
			/*
			{
				"id": "anthropic/claude-3.5-sonnet",
				"name": "Anthropic: Claude 3.5 Sonnet", 
				"created": 1718841600,
				"description": "Claude 3.5 Sonnet 提供比 Opus 更好的能力,比 Sonnet 更快的速度,价格与 Sonnet 相同。Sonnet 特别擅长:\n\n- 编码:自主编写、编辑和运行代码,具有推理和故障排除能力\n- 数据科学:增强人类数据科学专业知识;在使用多种工具获取见解的同时导航非结构化数据\n- 视觉处理:擅长解释图表、图形和图像,准确转录文本以获得超出文本本身的见解\n- 代理任务:出色的工具使用能力,非常适合代理任务(即需要与其他系统交互的复杂多步骤问题解决任务)\n\n#multimodal",
				"context_length": 200000,
				"architecture": {
					"modality": "text+image-\u003Etext",
					"tokenizer": "Claude",
					"instruct_type": null
				},
				"pricing": {
					"prompt": "0.000003",
					"completion": "0.000015", 
					"image": "0.0048",
					"request": "0"
				},
				"top_provider": {
					"context_length": 200000,
					"max_completion_tokens": 8192,
					"is_moderated": true
				},
				"per_request_limits": null
			},
			*/
			if (response.data?.data) {
				const rawModels = response.data.data
				const parsePrice = (price: any) => {
					if (price) {
						return parseFloat(price) * 1_000_000
					}
					return undefined
				}
				for (const rawModel of rawModels) {
					const modelInfo: ModelInfo = {
						maxTokens: rawModel.top_provider?.max_completion_tokens,
						contextWindow: rawModel.context_length,
						supportsImages: rawModel.architecture?.modality?.includes("image"),
						supportsPromptCache: false,
						inputPrice: parsePrice(rawModel.pricing?.prompt),
						outputPrice: parsePrice(rawModel.pricing?.completion),
						description: rawModel.description,
					}

					switch (rawModel.id) {
						case "anthropic/claude-3-7-sonnet":
						case "anthropic/claude-3-7-sonnet:beta":
						case "anthropic/claude-3.7-sonnet":
						case "anthropic/claude-3.7-sonnet:beta":
						case "anthropic/claude-3.7-sonnet:thinking":
						case "anthropic/claude-3.5-sonnet":
						case "anthropic/claude-3.5-sonnet:beta":
							// 注意:这需要与 api.ts/openrouter 默认模型信息同步
							modelInfo.supportsComputerUse = true
							modelInfo.supportsPromptCache = true
							modelInfo.cacheWritesPrice = 3.75
							modelInfo.cacheReadsPrice = 0.3
							break
						case "anthropic/claude-3.5-sonnet-20240620":
						case "anthropic/claude-3.5-sonnet-20240620:beta":
							modelInfo.supportsPromptCache = true
							modelInfo.cacheWritesPrice = 3.75
							modelInfo.cacheReadsPrice = 0.3
							break
						case "anthropic/claude-3-5-haiku":
						case "anthropic/claude-3-5-haiku:beta":
						case "anthropic/claude-3-5-haiku-20241022":
						case "anthropic/claude-3-5-haiku-20241022:beta":
						case "anthropic/claude-3.5-haiku":
						case "anthropic/claude-3.5-haiku:beta":
						case "anthropic/claude-3.5-haiku-20241022":
						case "anthropic/claude-3.5-haiku-20241022:beta":
							modelInfo.supportsPromptCache = true
							modelInfo.cacheWritesPrice = 1.25
							modelInfo.cacheReadsPrice = 0.1
							break
						case "anthropic/claude-3-opus":
						case "anthropic/claude-3-opus:beta":
							modelInfo.supportsPromptCache = true
							modelInfo.cacheWritesPrice = 18.75
							modelInfo.cacheReadsPrice = 1.5
							break
						case "anthropic/claude-3-haiku":
						case "anthropic/claude-3-haiku:beta":
							modelInfo.supportsPromptCache = true
							modelInfo.cacheWritesPrice = 0.3
							modelInfo.cacheReadsPrice = 0.03
							break
						case "deepseek/deepseek-chat":
							modelInfo.supportsPromptCache = true
							// 查看 api.ts/deepSeekModels 获取更多信息
							modelInfo.inputPrice = 0
							modelInfo.cacheWritesPrice = 0.14
							modelInfo.cacheReadsPrice = 0.014
							break
					}

					models[rawModel.id] = modelInfo
				}
			} else {
				console.error("OpenRouter API 返回无效响应")
			}
			await fs.writeFile(openRouterModelsFilePath, JSON.stringify(models))
			console.log("OpenRouter 模型已获取并保存", models)
		} catch (error) {
			console.error("获取 OpenRouter 模型时出错:", error)
		}

		await this.postMessageToWebview({
			type: "openRouterModels",
			openRouterModels: models,
		})
		return models
	}

	// 上下文菜单和代码操作

	getFileMentionFromPath(filePath: string) {
		const cwd = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).at(0)
		if (!cwd) {
			return "@/" + filePath
		}
		const relativePath = path.relative(cwd, filePath)
		return "@/" + relativePath
	}

	// 编辑器和代码操作中的"添加到 Cline"上下文菜单
	async addSelectedCodeToChat(code: string, filePath: string, languageId: string, diagnostics?: vscode.Diagnostic[]) {
		// 确保侧边栏视图可见
		await vscode.commands.executeCommand("claude-dev.SidebarProvider.focus")
		await setTimeoutPromise(100)

		// 将选中的代码发送到 webview
		const fileMention = this.getFileMentionFromPath(filePath)

		let input = `${fileMention}\n\`\`\`\n${code}\n\`\`\``
		if (diagnostics) {
			const problemsString = this.convertDiagnosticsToProblemsString(diagnostics)
			input += `\n问题:\n${problemsString}`
		}

		await this.postMessageToWebview({
			type: "addToInput",
			text: input,
		})

		console.log("addSelectedCodeToChat", code, filePath, languageId)
	}

	// 终端中的"添加到 Cline"上下文菜单
	async addSelectedTerminalOutputToChat(output: string, terminalName: string) {
		// 确保侧边栏视图可见
		await vscode.commands.executeCommand("claude-dev.SidebarProvider.focus")
		await setTimeoutPromise(100)

		// 将选中的终端输出发送到 webview
		await this.postMessageToWebview({
			type: "addToInput",
			text: `终端输出:\n\`\`\`\n${output}\n\`\`\``,
		})

		console.log("addSelectedTerminalOutputToChat", output, terminalName)
	}

	// 代码操作中的"使用 Cline 修复"
	async fixWithCline(code: string, filePath: string, languageId: string, diagnostics: vscode.Diagnostic[]) {
		// 确保侧边栏视图可见
		await vscode.commands.executeCommand("claude-dev.SidebarProvider.focus")
		await setTimeoutPromise(100)

		const fileMention = this.getFileMentionFromPath(filePath)
		const problemsString = this.convertDiagnosticsToProblemsString(diagnostics)
		await this.initClineWithTask(
			`修复 ${fileMention} 中的以下代码\n\`\`\`\n${code}\n\`\`\`\n\n问题:\n${problemsString}`,
		)

		console.log("fixWithCline", code, filePath, languageId, diagnostics, problemsString)
	}

	convertDiagnosticsToProblemsString(diagnostics: vscode.Diagnostic[]) {
		let problemsString = ""
		for (const diagnostic of diagnostics) {
			let label: string
			switch (diagnostic.severity) {
				case vscode.DiagnosticSeverity.Error:
					label = "错误"
					break
				case vscode.DiagnosticSeverity.Warning:
					label = "警告"
					break
				case vscode.DiagnosticSeverity.Information:
					label = "信息"
					break
				case vscode.DiagnosticSeverity.Hint:
					label = "提示"
					break
				default:
					label = "诊断"
			}
			const line = diagnostic.range.start.line + 1 // VSCode 行号从 0 开始
			const source = diagnostic.source ? `${diagnostic.source} ` : ""
			problemsString += `\n- [${source}${label}] 第 ${line} 行: ${diagnostic.message}`
		}
		problemsString = problemsString.trim()
		return problemsString
	}

	// 任务历史记录

	async getTaskWithId(id: string): Promise<{
		historyItem: HistoryItem
		taskDirPath: string
		apiConversationHistoryFilePath: string
		uiMessagesFilePath: string
		apiConversationHistory: Anthropic.MessageParam[]
	}> {
		const history = ((await this.getGlobalState("taskHistory")) as HistoryItem[] | undefined) || []
		const historyItem = history.find((item) => item.id === id)
		if (historyItem) {
			const taskDirPath = path.join(this.context.globalStorageUri.fsPath, "tasks", id)
			const apiConversationHistoryFilePath = path.join(taskDirPath, GlobalFileNames.apiConversationHistory)
			const uiMessagesFilePath = path.join(taskDirPath, GlobalFileNames.uiMessages)
			const fileExists = await fileExistsAtPath(apiConversationHistoryFilePath)
			if (fileExists) {
				const apiConversationHistory = JSON.parse(await fs.readFile(apiConversationHistoryFilePath, "utf8"))
				return {
					historyItem,
					taskDirPath,
					apiConversationHistoryFilePath,
					uiMessagesFilePath,
					apiConversationHistory,
				}
			}
		}
		// 如果尝试获取不存在的任务,从状态中删除它
		// FIXME: 有时候 json 文件因某些原因没有保存到磁盘时会发生这种情况
		await this.deleteTaskFromState(id)
		throw new Error("未找到任务")
	}

	async showTaskWithId(id: string) {
		if (id !== this.cline?.taskId) {
			// 非当前任务
			const { historyItem } = await this.getTaskWithId(id)
			await this.initClineWithHistoryItem(historyItem) // 清除现有任务
		}
		await this.postMessageToWebview({
			type: "action",
			action: "chatButtonClicked",
		})
	}

	async exportTaskWithId(id: string) {
		const { historyItem, apiConversationHistory } = await this.getTaskWithId(id)
		await downloadTask(historyItem.ts, apiConversationHistory)
	}

	async deleteAllTaskHistory() {
		await this.clearTask()
		await this.updateGlobalState("taskHistory", undefined)
		try {
			// 删除任务目录的所有内容
			const taskDirPath = path.join(this.context.globalStorageUri.fsPath, "tasks")
			if (await fileExistsAtPath(taskDirPath)) {
				await fs.rm(taskDirPath, { recursive: true, force: true })
			}
			// 删除检查点目录内容
			const checkpointsDirPath = path.join(this.context.globalStorageUri.fsPath, "checkpoints")
			if (await fileExistsAtPath(checkpointsDirPath)) {
				await fs.rm(checkpointsDirPath, { recursive: true, force: true })
			}
		} catch (error) {
			vscode.window.showErrorMessage(
				`删除任务历史记录时遇到错误,可能有一些文件未被删除。错误: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	async refreshTotalTasksSize() {
		getTotalTasksSize(this.context.globalStorageUri.fsPath)
			.then((newTotalSize) => {
				this.postMessageToWebview({
					type: "totalTasksSize",
					totalTasksSize: newTotalSize,
				})
			})
			.catch((error) => {
				console.error("计算任务总大小时出错:", error)
			})
	}

	async deleteTaskWithId(id: string) {
		console.info("deleteTaskWithId: ", id)

		try {
			if (id === this.cline?.taskId) {
				await this.clearTask()
				console.debug("已清除任务")
			}

			const { taskDirPath, apiConversationHistoryFilePath, uiMessagesFilePath } = await this.getTaskWithId(id)

			const updatedTaskHistory = await this.deleteTaskFromState(id)

			// 删除任务文件
			const apiConversationHistoryFileExists = await fileExistsAtPath(apiConversationHistoryFilePath)
			if (apiConversationHistoryFileExists) {
				await fs.unlink(apiConversationHistoryFilePath)
			}
			const uiMessagesFileExists = await fileExistsAtPath(uiMessagesFilePath)
			if (uiMessagesFileExists) {
				await fs.unlink(uiMessagesFilePath)
			}
			const legacyMessagesFilePath = path.join(taskDirPath, "claude_messages.json")
			if (await fileExistsAtPath(legacyMessagesFilePath)) {
				await fs.unlink(legacyMessagesFilePath)
			}

			await fs.rmdir(taskDirPath) // 如果目录为空则成功

			if (updatedTaskHistory.length === 0) {
				await this.deleteAllTaskHistory()
			}
		} catch (error) {
			console.debug(`删除任务时出错:`, error)
		}

		this.refreshTotalTasksSize()
	}

	async deleteTaskFromState(id: string) {
		// 从历史记录中删除任务
		const taskHistory = ((await this.getGlobalState("taskHistory")) as HistoryItem[] | undefined) || []
		const updatedTaskHistory = taskHistory.filter((task) => task.id !== id)
		await this.updateGlobalState("taskHistory", updatedTaskHistory)

		// 通知 webview 任务已被删除
		await this.postStateToWebview()

		return updatedTaskHistory
	}

	async postStateToWebview() {
		const state = await this.getStateToPostToWebview()
		this.postMessageToWebview({ type: "state", state })
	}

	async getStateToPostToWebview(): Promise<ExtensionState> {
		const {
			apiConfiguration,
			lastShownAnnouncementId,
			customInstructions,
			taskHistory,
			autoApprovalSettings,
			browserSettings,
			chatSettings,
			userInfo,
			mcpMarketplaceEnabled,
			telemetrySetting,
			planActSeparateModelsSetting,
		} = await this.getState()

		return {
			version: this.context.extension?.packageJSON?.version ?? "",
			apiConfiguration,
			customInstructions,
			uriScheme: vscode.env.uriScheme,
			currentTaskItem: this.cline?.taskId ? (taskHistory || []).find((item) => item.id === this.cline?.taskId) : undefined,
			checkpointTrackerErrorMessage: this.cline?.checkpointTrackerErrorMessage,
			clineMessages: this.cline?.clineMessages || [],
			taskHistory: (taskHistory || [])
				.filter((item) => item.ts && item.task)
				.sort((a, b) => b.ts - a.ts)
				.slice(0, 100), // 目前我们只获取最新的 100 个任务,但更好的解决方案是只传入 3 个用于最近任务历史记录,然后在需要时获取完整任务历史记录(可能带分页)
			shouldShowAnnouncement: lastShownAnnouncementId !== this.latestAnnouncementId,
			platform: process.platform as Platform,
			autoApprovalSettings,
			browserSettings,
			chatSettings,
			userInfo,
			mcpMarketplaceEnabled,
			telemetrySetting,
			planActSeparateModelsSetting,
			vscMachineId: vscode.env.machineId,
		}
	}

	async clearTask() {
		this.cline?.abortTask()
		this.cline = undefined // 删除对它的引用,这样一旦 promise 结束它就会被垃圾回收
	}

	// 缓存机制,用于跟踪每个提供程序实例的 webview 消息 + API 对话历史记录

	/*
	现在我们使用 retainContextWhenHidden,我们不必在用户状态中存储 cline 消息的缓存,但我们可以这样做以减少长对话中的内存占用。

	- 我们必须小心在 ClineProvider 实例之间共享的状态,因为同时可能运行多个扩展实例。例如,当我们使用相同的键缓存 cline 消息时,两个扩展实例可能最终使用相同的键并相互覆盖对方的消息。
	- 有些状态确实需要在实例之间共享,即 API 密钥 - 但是似乎没有好的方法来通知其他实例 API 密钥已更改。

	我们需要为每个 ClineProvider 实例的消息缓存使用唯一标识符,因为我们可能在侧边栏之外运行多个扩展实例,例如在编辑器面板中。

	// 在 API 请求中发送的对话历史记录

	/*
	似乎某些 API 消息不符合 vscode 状态要求。要么是 Anthropic 库在后端以某种方式操作这些值从而创建循环引用,要么是 API 返回函数或 Symbol 作为消息内容的一部分。
	VSCode 关于状态的文档:"值必须是 JSON 可字符串化的...值 — 一个值。不能包含循环引用。"
	目前我们将在内存中存储对话历史记录,如果我们需要直接存储在状态中,我们需要进行手动转换以确保正确的 json 字符串化。
	*/

	// getApiConversationHistory(): Anthropic.MessageParam[] {
	// 	// const history = (await this.getGlobalState(
	// 	// 	this.getApiConversationHistoryStateKey()
	// 	// )) as Anthropic.MessageParam[]
	// 	// return history || []
	// 	return this.apiConversationHistory
	// }

	// setApiConversationHistory(history: Anthropic.MessageParam[] | undefined) {
	// 	// await this.updateGlobalState(this.getApiConversationHistoryStateKey(), history)
	// 	this.apiConversationHistory = history || []
	// }

	// addMessageToApiConversationHistory(message: Anthropic.MessageParam): Anthropic.MessageParam[] {
	// 	// const history = await this.getApiConversationHistory()
	// 	// history.push(message)
	// 	// await this.setApiConversationHistory(history)
	// 	// return history
	// 	this.apiConversationHistory.push(message)
	// 	return this.apiConversationHistory
	// }

	/*
	存储
	https://dev.to/kompotkot/how-to-use-secretstorage-in-your-vscode-extensions-2hco
	https://www.eliostruyf.com/devhack-code-extension-storage-options/
	*/

	async getState() {
		const [
			storedApiProvider,
			apiModelId,
			apiKey,
			openRouterApiKey,
			clineApiKey,
			awsAccessKey,
			awsSecretKey,
			awsSessionToken,
			awsRegion,
			awsUseCrossRegionInference,
			awsBedrockUsePromptCache,
			awsBedrockEndpoint,
			awsProfile,
			awsUseProfile,
			vertexProjectId,
			vertexRegion,
			openAiBaseUrl,
			openAiApiKey,
			openAiModelId,
			openAiModelInfo,
			ollamaModelId,
			ollamaBaseUrl,
			ollamaApiOptionsCtxNum,
			lmStudioModelId,
			lmStudioBaseUrl,
			anthropicBaseUrl,
			geminiApiKey,
			openAiNativeApiKey,
			deepSeekApiKey,
			requestyApiKey,
			requestyModelId,
			togetherApiKey,
			togetherModelId,
			qwenApiKey,
			mistralApiKey,
			azureApiVersion,
			openRouterModelId,
			openRouterModelInfo,
			openRouterProviderSorting,
			lastShownAnnouncementId,
			customInstructions,
			taskHistory,
			autoApprovalSettings,
			browserSettings,
			chatSettings,
			vsCodeLmModelSelector,
			liteLlmBaseUrl,
			liteLlmModelId,
			userInfo,
			previousModeApiProvider,
			previousModeModelId,
			previousModeModelInfo,
			previousModeVsCodeLmModelSelector,
			previousModeThinkingBudgetTokens,
			qwenApiLine,
			liteLlmApiKey,
			telemetrySetting,
			asksageApiKey,
			asksageApiUrl,
			xaiApiKey,
			thinkingBudgetTokens,
			sambanovaApiKey,
			planActSeparateModelsSettingRaw,
		] = await Promise.all([
			this.getGlobalState("apiProvider") as Promise<ApiProvider | undefined>,
			this.getGlobalState("apiModelId") as Promise<string | undefined>,
			this.getSecret("apiKey") as Promise<string | undefined>,
			this.getSecret("openRouterApiKey") as Promise<string | undefined>,
			this.getSecret("clineApiKey") as Promise<string | undefined>,
			this.getSecret("awsAccessKey") as Promise<string | undefined>,
			this.getSecret("awsSecretKey") as Promise<string | undefined>,
			this.getSecret("awsSessionToken") as Promise<string | undefined>,
			this.getGlobalState("awsRegion") as Promise<string | undefined>,
			this.getGlobalState("awsUseCrossRegionInference") as Promise<boolean | undefined>,
			this.getGlobalState("awsBedrockUsePromptCache") as Promise<boolean | undefined>,
			this.getGlobalState("awsBedrockEndpoint") as Promise<string | undefined>,
			this.getGlobalState("awsProfile") as Promise<string | undefined>,
			this.getGlobalState("awsUseProfile") as Promise<boolean | undefined>,
			this.getGlobalState("vertexProjectId") as Promise<string | undefined>,
			this.getGlobalState("vertexRegion") as Promise<string | undefined>,
			this.getGlobalState("openAiBaseUrl") as Promise<string | undefined>,
			this.getSecret("openAiApiKey") as Promise<string | undefined>,
			this.getGlobalState("openAiModelId") as Promise<string | undefined>,
			this.getGlobalState("openAiModelInfo") as Promise<ModelInfo | undefined>,
			this.getGlobalState("ollamaModelId") as Promise<string | undefined>,
			this.getGlobalState("ollamaBaseUrl") as Promise<string | undefined>,
			this.getGlobalState("ollamaApiOptionsCtxNum") as Promise<string | undefined>,
			this.getGlobalState("lmStudioModelId") as Promise<string | undefined>,
			this.getGlobalState("lmStudioBaseUrl") as Promise<string | undefined>,
			this.getGlobalState("anthropicBaseUrl") as Promise<string | undefined>,
			this.getSecret("geminiApiKey") as Promise<string | undefined>,
			this.getSecret("openAiNativeApiKey") as Promise<string | undefined>,
			this.getSecret("deepSeekApiKey") as Promise<string | undefined>,
			this.getSecret("requestyApiKey") as Promise<string | undefined>,
			this.getGlobalState("requestyModelId") as Promise<string | undefined>,
			this.getSecret("togetherApiKey") as Promise<string | undefined>,
			this.getGlobalState("togetherModelId") as Promise<string | undefined>,
			this.getSecret("qwenApiKey") as Promise<string | undefined>,
			this.getSecret("mistralApiKey") as Promise<string | undefined>,
			this.getGlobalState("azureApiVersion") as Promise<string | undefined>,
			this.getGlobalState("openRouterModelId") as Promise<string | undefined>,
			this.getGlobalState("openRouterModelInfo") as Promise<ModelInfo | undefined>,
			this.getGlobalState("openRouterProviderSorting") as Promise<string | undefined>,
			this.getGlobalState("lastShownAnnouncementId") as Promise<string | undefined>,
			this.getGlobalState("customInstructions") as Promise<string | undefined>,
			this.getGlobalState("taskHistory") as Promise<HistoryItem[] | undefined>,
			this.getGlobalState("autoApprovalSettings") as Promise<AutoApprovalSettings | undefined>,
			this.getGlobalState("browserSettings") as Promise<BrowserSettings | undefined>,
			this.getGlobalState("chatSettings") as Promise<ChatSettings | undefined>,
			this.getGlobalState("vsCodeLmModelSelector") as Promise<vscode.LanguageModelChatSelector | undefined>,
			this.getGlobalState("liteLlmBaseUrl") as Promise<string | undefined>,
			this.getGlobalState("liteLlmModelId") as Promise<string | undefined>,
			this.getGlobalState("userInfo") as Promise<UserInfo | undefined>,
			this.getGlobalState("previousModeApiProvider") as Promise<ApiProvider | undefined>,
			this.getGlobalState("previousModeModelId") as Promise<string | undefined>,
			this.getGlobalState("previousModeModelInfo") as Promise<ModelInfo | undefined>,
			this.getGlobalState("previousModeVsCodeLmModelSelector") as Promise<vscode.LanguageModelChatSelector | undefined>,
			this.getGlobalState("previousModeThinkingBudgetTokens") as Promise<number | undefined>,
			this.getGlobalState("qwenApiLine") as Promise<string | undefined>,
			this.getSecret("liteLlmApiKey") as Promise<string | undefined>,
			this.getGlobalState("telemetrySetting") as Promise<TelemetrySetting | undefined>,
			this.getSecret("asksageApiKey") as Promise<string | undefined>,
			this.getGlobalState("asksageApiUrl") as Promise<string | undefined>,
			this.getSecret("xaiApiKey") as Promise<string | undefined>,
			this.getGlobalState("thinkingBudgetTokens") as Promise<number | undefined>,
			this.getSecret("sambanovaApiKey") as Promise<string | undefined>,
			this.getGlobalState("planActSeparateModelsSetting") as Promise<boolean | undefined>,
		])

		let apiProvider: ApiProvider
		if (storedApiProvider) {
			apiProvider = storedApiProvider
		} else {
			// Either new user or legacy user that doesn't have the apiProvider stored in state
			// (If they're using OpenRouter or Bedrock, then apiProvider state will exist)
			if (apiKey) {
				apiProvider = "anthropic"
			} else {
				// New users should default to openrouter, since they've opted to use an API key instead of signing in
				apiProvider = "openrouter"
			}
		}

		const o3MiniReasoningEffort = vscode.workspace
			.getConfiguration("cline.modelSettings.o3Mini")
			.get("reasoningEffort", "medium")

		const mcpMarketplaceEnabled = vscode.workspace.getConfiguration("cline").get<boolean>("mcpMarketplace.enabled", true)

		// Plan/Act separate models setting is a boolean indicating whether the user wants to use different models for plan and act. Existing users expect this to be enabled, while we want new users to opt in to this being disabled by default.
		// On win11 state sometimes initializes as empty string instead of undefined
		let planActSeparateModelsSetting: boolean | undefined = undefined
		if (planActSeparateModelsSettingRaw === true || planActSeparateModelsSettingRaw === false) {
			planActSeparateModelsSetting = planActSeparateModelsSettingRaw
		} else {
			// default to true for existing users
			if (storedApiProvider) {
				planActSeparateModelsSetting = true
			} else {
				// default to false for new users
				planActSeparateModelsSetting = false
			}
			// this is a special case where it's a new state, but we want it to default to different values for existing and new users.
			// persist so next time state is retrieved it's set to the correct value.
			await this.updateGlobalState("planActSeparateModelsSetting", planActSeparateModelsSetting)
		}

		return {
			apiConfiguration: {
				apiProvider,
				apiModelId,
				apiKey,
				openRouterApiKey,
				clineApiKey,
				awsAccessKey,
				awsSecretKey,
				awsSessionToken,
				awsRegion,
				awsUseCrossRegionInference,
				awsBedrockUsePromptCache,
				awsBedrockEndpoint,
				awsProfile,
				awsUseProfile,
				vertexProjectId,
				vertexRegion,
				openAiBaseUrl,
				openAiApiKey,
				openAiModelId,
				openAiModelInfo,
				ollamaModelId,
				ollamaBaseUrl,
				ollamaApiOptionsCtxNum,
				lmStudioModelId,
				lmStudioBaseUrl,
				anthropicBaseUrl,
				geminiApiKey,
				openAiNativeApiKey,
				deepSeekApiKey,
				requestyApiKey,
				requestyModelId,
				togetherApiKey,
				togetherModelId,
				qwenApiKey,
				qwenApiLine,
				mistralApiKey,
				azureApiVersion,
				openRouterModelId,
				openRouterModelInfo,
				openRouterProviderSorting,
				vsCodeLmModelSelector,
				o3MiniReasoningEffort,
				thinkingBudgetTokens,
				liteLlmBaseUrl,
				liteLlmModelId,
				liteLlmApiKey,
				asksageApiKey,
				asksageApiUrl,
				xaiApiKey,
				sambanovaApiKey,
			},
			lastShownAnnouncementId,
			customInstructions,
			taskHistory,
			autoApprovalSettings: autoApprovalSettings || DEFAULT_AUTO_APPROVAL_SETTINGS, // default value can be 0 or empty string
			browserSettings: browserSettings || DEFAULT_BROWSER_SETTINGS,
			chatSettings: chatSettings || DEFAULT_CHAT_SETTINGS,
			userInfo,
			previousModeApiProvider,
			previousModeModelId,
			previousModeModelInfo,
			previousModeVsCodeLmModelSelector,
			previousModeThinkingBudgetTokens,
			mcpMarketplaceEnabled,
			telemetrySetting: telemetrySetting || "unset",
			planActSeparateModelsSetting,
		}
	}

	async updateTaskHistory(item: HistoryItem): Promise<HistoryItem[]> {
		const history = ((await this.getGlobalState("taskHistory")) as HistoryItem[]) || []
		const existingItemIndex = history.findIndex((h) => h.id === item.id)
		if (existingItemIndex !== -1) {
			history[existingItemIndex] = item
		} else {
			history.push(item)
		}
		await this.updateGlobalState("taskHistory", history)
		return history
	}

	// global

	async updateGlobalState(key: GlobalStateKey, value: any) {
		await this.context.globalState.update(key, value)
	}

	async getGlobalState(key: GlobalStateKey) {
		return await this.context.globalState.get(key)
	}

	// workspace

	private async updateWorkspaceState(key: string, value: any) {
		await this.context.workspaceState.update(key, value)
	}

	private async getWorkspaceState(key: string) {
		return await this.context.workspaceState.get(key)
	}

	// private async clearState() {
	// 	this.context.workspaceState.keys().forEach((key) => {
	// 		this.context.workspaceState.update(key, undefined)
	// 	})
	// 	this.context.globalState.keys().forEach((key) => {
	// 		this.context.globalState.update(key, undefined)
	// 	})
	// 	this.context.secrets.delete("apiKey")
	// }

	// secrets

	private async storeSecret(key: SecretKey, value?: string) {
		if (value) {
			await this.context.secrets.store(key, value)
		} else {
			await this.context.secrets.delete(key)
		}
	}

	async getSecret(key: SecretKey) {
		return await this.context.secrets.get(key)
	}

	// Open Graph Data

	async fetchOpenGraphData(url: string) {
		try {
			// 使用 link-preview.ts 中的 fetchOpenGraphData 函数
			const ogData = await fetchOpenGraphData(url)

			// 将数据发送回 webview
			await this.postMessageToWebview({
				type: "openGraphData", 
				openGraphData: ogData,
				url: url,
			})
		} catch (error) {
			console.error(`获取 ${url} 的 Open Graph 数据时出错:`, error)
			// 发送错误响应
			await this.postMessageToWebview({
				type: "openGraphData",
				error: `获取 Open Graph 数据失败: ${error}`,
				url: url,
			})
		}
	}

	// 检查 URL 是否为图片
	async checkIsImageUrl(url: string) {
		try {
			// 检查 URL 是否为图片
			const isImage = await isImageUrl(url)

			// 将结果发送回 webview
			await this.postMessageToWebview({
				type: "isImageUrlResult",
				isImage,
				url,
			})
		} catch (error) {
			console.error(`检查 URL 是否为图片时出错: ${url}`, error)
			// 发送错误响应
			await this.postMessageToWebview({
				type: "isImageUrlResult",
				isImage: false,
				url,
			})
		}
	}

	// 开发

	async resetState() {
		vscode.window.showInformationMessage("正在重置状态...")
		for (const key of this.context.globalState.keys()) {
			await this.context.globalState.update(key, undefined)
		}
		const secretKeys: SecretKey[] = [
			"apiKey",
			"openRouterApiKey", 
			"awsAccessKey",
			"awsSecretKey",
			"awsSessionToken",
			"openAiApiKey",
			"geminiApiKey",
			"openAiNativeApiKey",
			"deepSeekApiKey",
			"requestyApiKey",
			"togetherApiKey",
			"qwenApiKey",
			"mistralApiKey",
			"clineApiKey",
			"liteLlmApiKey",
			"asksageApiKey",
			"xaiApiKey",
			"sambanovaApiKey",
		]
		for (const key of secretKeys) {
			await this.storeSecret(key, undefined)
		}
		if (this.cline) {
			this.cline.abortTask()
			this.cline = undefined
		}
		vscode.window.showInformationMessage("状态已重置")
		await this.postStateToWebview()
		await this.postMessageToWebview({
			type: "action",
			action: "chatButtonClicked",
		})
	}
}
