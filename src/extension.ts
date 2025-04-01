// 'vscode' 模块包含 VS Code 可扩展性 API
// 导入模块并在下面的代码中使用别名 vscode 引用它
import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import * as vscode from "vscode"
import { ClineProvider } from "./core/webview/ClineProvider"
import { Logger } from "./services/logging/Logger"
import { createClineAPI } from "./exports"
import "./utils/path" // 需要访问 String.prototype.toPosix
import { DIFF_VIEW_URI_SCHEME } from "./integrations/editor/DiffViewProvider"
import assert from "node:assert"
import { telemetryService } from "./services/telemetry/TelemetryService"

/*
使用 https://github.com/microsoft/vscode-webview-ui-toolkit 构建

灵感来自
https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/default/weather-webview
https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/frameworks/hello-world-react-cra

*/

let outputChannel: vscode.OutputChannel

// 当您的扩展程序被激活时，将调用此方法
// 您的扩展程序在首次执行命令时被激活
export function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel("Cline")
	context.subscriptions.push(outputChannel)

	Logger.initialize(outputChannel)
	Logger.log("Cline 扩展已激活")

	const sidebarProvider = new ClineProvider(context, outputChannel)

	vscode.commands.executeCommand("setContext", "clineChinese.isDevMode", IS_DEV && IS_DEV === "true")

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ClineProvider.sideBarId, sidebarProvider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("clineChinese.plusButtonClicked", async () => {
			Logger.log("加号按钮已点击")
			await sidebarProvider.clearTask()
			await sidebarProvider.postStateToWebview()
			await sidebarProvider.postMessageToWebview({
				type: "action",
				action: "chatButtonClicked",
			})
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("clineChinese.mcpButtonClicked", () => {
			sidebarProvider.postMessageToWebview({
				type: "action",
				action: "mcpButtonClicked",
			})
		}),
	)

	const openClineInNewTab = async () => {
		Logger.log("正在新标签页中打开 Cline")
		// (此示例使用 webviewProvider 激活事件，这对于反序列化缓存的 webview 是必需的，但由于我们使用 retainContextWhenHidden，因此不需要使用该事件)
		// https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
		const tabProvider = new ClineProvider(context, outputChannel)
		//const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined
		const lastCol = Math.max(...vscode.window.visibleTextEditors.map((editor) => editor.viewColumn || 0))

		// 检查是否有任何可见的文本编辑器，否则在右侧打开一个新组
		const hasVisibleEditors = vscode.window.visibleTextEditors.length > 0
		if (!hasVisibleEditors) {
			await vscode.commands.executeCommand("workbench.action.newGroupRight")
		}
		const targetCol = hasVisibleEditors ? Math.max(lastCol + 1, 1) : vscode.ViewColumn.Two

		const panel = vscode.window.createWebviewPanel(ClineProvider.tabPanelId, "Cline", targetCol, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [context.extensionUri],
		})
		// TODO: 使用具有浅色和深色变体的更好的 svg 图标 (参见 https://stackoverflow.com/questions/58365687/vscode-extension-iconpath)

		panel.iconPath = {
			light: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "robot_panel_light.png"),
			dark: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "robot_panel_dark.png"),
		}
		tabProvider.resolveWebviewView(panel)

		// 锁定编辑器组，这样点击文件时不会在面板上方打开它们
		await setTimeoutPromise(100)
		await vscode.commands.executeCommand("workbench.action.lockEditorGroup")
	}

	context.subscriptions.push(vscode.commands.registerCommand("clineChinese.popoutButtonClicked", openClineInNewTab))
	context.subscriptions.push(vscode.commands.registerCommand("clineChinese.openInNewTab", openClineInNewTab))

	context.subscriptions.push(
		vscode.commands.registerCommand("clineChinese.settingsButtonClicked", () => {
			//vscode.window.showInformationMessage(message)
			sidebarProvider.postMessageToWebview({
				type: "action",
				action: "settingsButtonClicked",
			})
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("clineChinese.historyButtonClicked", () => {
			sidebarProvider.postMessageToWebview({
				type: "action",
				action: "historyButtonClicked",
			})
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("clineChinese.accountButtonClicked", () => {
			sidebarProvider.postMessageToWebview({
				type: "action",
				action: "accountButtonClicked",
			})
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("clineChinese.openDocumentation", () => {
			vscode.env.openExternal(vscode.Uri.parse("https://hybridtalentcomputing.gitbook.io/cline-chinese-doc/"))
		}),
	)

	/*
	我们使用文本文件内容提供程序 API 通过为原始内容创建虚拟文件来显示差异视图的左侧。这使其成为只读，以便用户知道如果想保留更改，需要编辑右侧。

	- 此 API 允许您从任意来源在 VSCode 中创建只读文件，其工作方式是声明一个 uri 方案，您的提供程序随后会为其返回文本内容。注册提供程序时必须提供该方案，之后不能更改。
	- 请注意，提供程序不会为虚拟文件创建 uri - 它的作用是根据给定的 uri 提供内容。作为回报，内容提供程序被连接到打开文件的逻辑中，因此始终会考虑提供程序。
	https://code.visualstudio.com/api/extension-guides/virtual-documents
	*/
	const diffContentProvider = new (class implements vscode.TextDocumentContentProvider {
		provideTextDocumentContent(uri: vscode.Uri): string {
			return Buffer.from(uri.query, "base64").toString("utf-8")
		}
	})()
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DIFF_VIEW_URI_SCHEME, diffContentProvider))

	// URI 处理程序
	const handleUri = async (uri: vscode.Uri) => {
		console.log("URI 处理程序已调用，参数:", {
			path: uri.path,
			query: uri.query,
			scheme: uri.scheme,
		})

		const path = uri.path
		const query = new URLSearchParams(uri.query.replace(/\+/g, "%2B"))
		const visibleProvider = ClineProvider.getVisibleInstance()
		if (!visibleProvider) {
			return
		}
		switch (path) {
			case "/openrouter": {
				const code = query.get("code")
				if (code) {
					await visibleProvider.handleOpenRouterCallback(code)
				}
				break
			}
			case "/auth": {
				const token = query.get("token")
				const state = query.get("state")
				const apiKey = query.get("apiKey")

				console.log("收到身份验证回调:", {
					token: token,
					state: state,
					apiKey: apiKey,
				})

				// 验证 state 参数
				if (!(await visibleProvider.validateAuthState(state))) {
					vscode.window.showErrorMessage("无效的身份验证状态")
					return
				}

				if (token && apiKey) {
					await visibleProvider.handleAuthCallback(token, apiKey)
				}
				break
			}
			default:
				break
		}
	}
	context.subscriptions.push(vscode.window.registerUriHandler({ handleUri }))

	// 在开发模式下注册大小测试命令
	if (IS_DEV && IS_DEV === "true") {
		// 使用动态导入以避免在生产环境中加载模块
		import("./dev/commands/tasks")
			.then((module) => {
				const devTaskCommands = module.registerTaskCommands(context, sidebarProvider)
				context.subscriptions.push(...devTaskCommands)
				Logger.log("Cline 开发任务命令已注册")
			})
			.catch((error) => {
				Logger.log("注册开发任务命令失败: " + error)
			})
	}

	context.subscriptions.push(
		vscode.commands.registerCommand("clineChinese.addToChat", async (range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) => {
			const editor = vscode.window.activeTextEditor
			if (!editor) {
				return
			}

			// 如果提供了范围，则使用提供的范围，否则使用当前选择
			// (vscode 命令默认在第一个参数中传递参数，因此我们需要确保它是一个 Range 对象)
			const textRange = range instanceof vscode.Range ? range : editor.selection
			const selectedText = editor.document.getText(textRange)

			if (!selectedText) {
				return
			}

			// 获取文件路径和语言 ID
			const filePath = editor.document.uri.fsPath
			const languageId = editor.document.languageId

			// 发送到侧边栏提供程序
			await sidebarProvider.addSelectedCodeToChat(
				selectedText,
				filePath,
				languageId,
				Array.isArray(diagnostics) ? diagnostics : undefined,
			)
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("clineChinese.addTerminalOutputToChat", async () => {
			const terminal = vscode.window.activeTerminal
			if (!terminal) {
				return
			}

			// 保存当前剪贴板内容
			const tempCopyBuffer = await vscode.env.clipboard.readText()

			try {
				// 复制*现有*的终端选择（不全选）
				await vscode.commands.executeCommand("workbench.action.terminal.copySelection")

				// 获取复制的内容
				let terminalContents = (await vscode.env.clipboard.readText()).trim()

				// 恢复原始剪贴板内容
				await vscode.env.clipboard.writeText(tempCopyBuffer)

				if (!terminalContents) {
					// 未复制任何终端内容（要么未选择任何内容，要么出现错误）
					return
				}

				// [可选] 处理多行内容的任何附加逻辑可以保留在此处
				// 例如:
				/*
				const lines = terminalContents.split("\n")
				const lastLine = lines.pop()?.trim()
				if (lastLine) {
					let i = lines.length - 1
					while (i >= 0 && !lines[i].trim().startsWith(lastLine)) {
						i--
					}
					terminalContents = lines.slice(Math.max(i, 0)).join("\n")
				}
				*/

				// 发送到侧边栏提供程序
				await sidebarProvider.addSelectedTerminalOutputToChat(terminalContents, terminal.name)
			} catch (error) {
				// 确保即使发生错误也要恢复剪贴板
				await vscode.env.clipboard.writeText(tempCopyBuffer)
				console.error("获取终端内容时出错:", error)
				vscode.window.showErrorMessage("获取终端内容失败")
			}
		}),
	)

	// 注册代码操作提供程序
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			"*",
			new (class implements vscode.CodeActionProvider {
				public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix]

				provideCodeActions(
					document: vscode.TextDocument,
					range: vscode.Range,
					context: vscode.CodeActionContext,
				): vscode.CodeAction[] {
					// 扩展范围以包含周围的 3 行
					const expandedRange = new vscode.Range(
						Math.max(0, range.start.line - 3),
						0,
						Math.min(document.lineCount - 1, range.end.line + 3),
						document.lineAt(Math.min(document.lineCount - 1, range.end.line + 3)).text.length,
					)

					const addAction = new vscode.CodeAction("添加到 Cline", vscode.CodeActionKind.QuickFix)
					addAction.command = {
						command: "clineChinese.addToChat",
						title: "添加到 Cline",
						arguments: [expandedRange, context.diagnostics],
					}

					const fixAction = new vscode.CodeAction("使用 Cline 修复", vscode.CodeActionKind.QuickFix)
					fixAction.command = {
						command: "clineChinese.fixWithCline",
						title: "使用 Cline 修复",
						arguments: [expandedRange, context.diagnostics],
					}

					// 仅在有错误时显示操作
					if (context.diagnostics.length > 0) {
						return [addAction, fixAction]
					} else {
						return []
					}
				}
			})(),
			{
				providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
			},
		),
	)

	// 注册命令处理程序
	context.subscriptions.push(
		vscode.commands.registerCommand("clineChinese.fixWithCline", async (range: vscode.Range, diagnostics: any[]) => {
			const editor = vscode.window.activeTextEditor
			if (!editor) {
				return
			}

			const selectedText = editor.document.getText(range)
			const filePath = editor.document.uri.fsPath
			const languageId = editor.document.languageId

			// 连同诊断信息一起发送到侧边栏提供程序
			await sidebarProvider.fixWithCline(selectedText, filePath, languageId, diagnostics)
		}),
	)

	return createClineAPI(outputChannel, sidebarProvider)
}

// 当您的扩展程序被停用时，将调用此方法
export function deactivate() {
	telemetryService.shutdown()
	Logger.log("Cline 扩展已停用")
}

// TODO: 寻找自动从生产构建中移除开发相关内容的解决方案。
//  这种类型的代码在生产环境中保留是可以的。我们只是希望将其从生产构建中移除
//  以减小构建资产的大小。
//
// 这是一个在源代码更改时重新加载扩展程序的变通方法
// 因为 vscode 不支持扩展程序的热重载
const { IS_DEV, DEV_WORKSPACE_FOLDER } = process.env

if (IS_DEV && IS_DEV !== "false") {
	assert(DEV_WORKSPACE_FOLDER, "必须在开发环境中设置 DEV_WORKSPACE_FOLDER")
	const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(DEV_WORKSPACE_FOLDER, "src/**/*"))

	watcher.onDidChange(({ scheme, path }) => {
		console.info(`${scheme} ${path} 已更改。正在重新加载 VSCode...`)

		vscode.commands.executeCommand("workbench.action.reloadWindow")
	})
}
