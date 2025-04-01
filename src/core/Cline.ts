import { Anthropic } from "@anthropic-ai/sdk"
import cloneDeep from "clone-deep"
import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import fs from "fs/promises"
import getFolderSize from "get-folder-size"
import os from "os"
import pWaitFor from "p-wait-for"
import * as path from "path"
import { serializeError } from "serialize-error"
import * as vscode from "vscode"
import { ApiHandler, buildApiHandler } from "../api"
import { OpenRouterHandler } from "../api/providers/openrouter"
import CheckpointTracker from "../integrations/checkpoints/CheckpointTracker"
import { DIFF_VIEW_URI_SCHEME, DiffViewProvider } from "../integrations/editor/DiffViewProvider"
import { formatContentBlockToMarkdown } from "../integrations/misc/export-markdown"
import { extractTextFromFile } from "../integrations/misc/extract-text"
import { showSystemNotification } from "../integrations/notifications"
import { TerminalManager } from "../integrations/terminal/TerminalManager"
import { BrowserSession } from "../services/browser/BrowserSession"
import { UrlContentFetcher } from "../services/browser/UrlContentFetcher"
import { listFiles } from "../services/glob/list-files"
import { regexSearchFiles } from "../services/ripgrep"
import { parseSourceCodeForDefinitionsTopLevel } from "../services/tree-sitter"
import { ApiConfiguration } from "../shared/api"
import { findLast, findLastIndex, parsePartialArrayString } from "../shared/array"
import { AutoApprovalSettings } from "../shared/AutoApprovalSettings"
import { BrowserSettings } from "../shared/BrowserSettings"
import { ChatSettings } from "../shared/ChatSettings"
import { combineApiRequests } from "../shared/combineApiRequests"
import { combineCommandSequences, COMMAND_REQ_APP_STRING } from "../shared/combineCommandSequences"
import {
	BrowserAction,
	BrowserActionResult,
	browserActions,
	ClineApiReqCancelReason,
	ClineApiReqInfo,
	ClineAsk,
	ClineAskQuestion,
	ClineAskUseMcpServer,
	ClineMessage,
	ClinePlanModeResponse,
	ClineSay,
	ClineSayBrowserAction,
	ClineSayTool,
	COMPLETION_RESULT_CHANGES_FLAG,
} from "../shared/ExtensionMessage"
import { getApiMetrics } from "../shared/getApiMetrics"
import { HistoryItem } from "../shared/HistoryItem"
import { ClineAskResponse, ClineCheckpointRestore } from "../shared/WebviewMessage"
import { calculateApiCostAnthropic } from "../utils/cost"
import { fileExistsAtPath, isDirectory } from "../utils/fs"
import { arePathsEqual, getReadablePath } from "../utils/path"
import { fixModelHtmlEscaping, removeInvalidChars } from "../utils/string"
import { AssistantMessageContent, parseAssistantMessage, ToolParamName, ToolUseName } from "./assistant-message"
import { constructNewFileContent } from "./assistant-message/diff"
import { ClineIgnoreController, LOCK_TEXT_SYMBOL } from "./ignore/ClineIgnoreController"
import { parseMentions } from "./mentions"
import { formatResponse } from "./prompts/responses"
import { addUserInstructions, SYSTEM_PROMPT } from "./prompts/system"
import { ContextManager } from "./context-management/ContextManager"
import { OpenAiHandler } from "../api/providers/openai"
import { ApiStream } from "../api/transform/stream"
import { ClineHandler } from "../api/providers/cline"
import { ClineProvider } from "./webview/ClineProvider"
import { DEFAULT_LANGUAGE_SETTINGS, getLanguageKey, LanguageDisplay, LanguageKey } from "../shared/Languages"
import { telemetryService } from "../services/telemetry/TelemetryService"
import pTimeout from "p-timeout"
import { GlobalFileNames } from "../global-constants"
import {
	checkIsAnthropicContextWindowError,
	checkIsOpenRouterContextWindowError,
} from "./context-management/context-error-handling"
import { AnthropicHandler } from "../api/providers/anthropic"

const cwd = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).at(0) ?? path.join(os.homedir(), "Desktop") // may or may not exist but fs checking existence would immediately ask for permission which would be bad UX, need to come up with a better solution

type ToolResponse = string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>
type UserContent = Array<Anthropic.ContentBlockParam>

export class Cline {
	readonly taskId: string
	readonly apiProvider?: string
	api: ApiHandler
	private terminalManager: TerminalManager
	private urlContentFetcher: UrlContentFetcher
	browserSession: BrowserSession
	contextManager: ContextManager
	private didEditFile: boolean = false
	customInstructions?: string
	autoApprovalSettings: AutoApprovalSettings
	private browserSettings: BrowserSettings
	private chatSettings: ChatSettings
	apiConversationHistory: Anthropic.MessageParam[] = []
	clineMessages: ClineMessage[] = []
	private clineIgnoreController: ClineIgnoreController
	private askResponse?: ClineAskResponse
	private askResponseText?: string
	private askResponseImages?: string[]
	private lastMessageTs?: number
	private consecutiveAutoApprovedRequestsCount: number = 0
	private consecutiveMistakeCount: number = 0
	private providerRef: WeakRef<ClineProvider>
	private abort: boolean = false
	didFinishAbortingStream = false
	abandoned = false
	private diffViewProvider: DiffViewProvider
	private checkpointTracker?: CheckpointTracker
	checkpointTrackerErrorMessage?: string
	conversationHistoryDeletedRange?: [number, number]
	isInitialized = false
	isAwaitingPlanResponse = false
	didRespondToPlanAskBySwitchingMode = false

	// streaming
	isWaitingForFirstChunk = false
	isStreaming = false
	private currentStreamingContentIndex = 0
	private assistantMessageContent: AssistantMessageContent[] = []
	private presentAssistantMessageLocked = false
	private presentAssistantMessageHasPendingUpdates = false
	private userMessageContent: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = []
	private userMessageContentReady = false
	private didRejectTool = false
	private didAlreadyUseTool = false
	private didCompleteReadingStream = false
	private didAutomaticallyRetryFailedApiRequest = false

	constructor(
		provider: ClineProvider,
		apiConfiguration: ApiConfiguration,
		autoApprovalSettings: AutoApprovalSettings,
		browserSettings: BrowserSettings,
		chatSettings: ChatSettings,
		customInstructions?: string,
		task?: string,
		images?: string[],
		historyItem?: HistoryItem,
	) {
		this.clineIgnoreController = new ClineIgnoreController(cwd)
		this.clineIgnoreController.initialize().catch((error) => {
			console.error("初始化 ClineIgnoreController 失败:", error)
		})
		this.providerRef = new WeakRef(provider)
		this.apiProvider = apiConfiguration.apiProvider
		this.api = buildApiHandler(apiConfiguration)
		this.terminalManager = new TerminalManager()
		this.urlContentFetcher = new UrlContentFetcher(provider.context)
		this.browserSession = new BrowserSession(provider.context, browserSettings)
		this.contextManager = new ContextManager()
		this.diffViewProvider = new DiffViewProvider(cwd)
		this.customInstructions = customInstructions
		this.autoApprovalSettings = autoApprovalSettings
		this.browserSettings = browserSettings
		this.chatSettings = chatSettings
		if (historyItem) {
			this.taskId = historyItem.id
			this.conversationHistoryDeletedRange = historyItem.conversationHistoryDeletedRange
			this.resumeTaskFromHistory()
		} else if (task || images) {
			this.taskId = Date.now().toString()
			this.startTask(task, images)
		} else {
			throw new Error("必须提供 historyItem 或 task/images")
		}

		if (historyItem) {
			// 从历史记录中打开任务
			telemetryService.captureTaskRestarted(this.taskId, this.apiProvider)
		} else {
			// 新任务已启动
			telemetryService.captureTaskCreated(this.taskId, this.apiProvider)
		}
	}

	updateBrowserSettings(browserSettings: BrowserSettings) {
		this.browserSettings = browserSettings
		this.browserSession.browserSettings = browserSettings
	}

	updateChatSettings(chatSettings: ChatSettings) {
		this.chatSettings = chatSettings
	}

	// 将任务存储到磁盘以供历史记录使用

	private async ensureTaskDirectoryExists(): Promise<string> {
		const globalStoragePath = this.providerRef.deref()?.context.globalStorageUri.fsPath
		if (!globalStoragePath) {
			throw new Error("全局存储 URI 无效")
		}
		const taskDir = path.join(globalStoragePath, "tasks", this.taskId)
		await fs.mkdir(taskDir, { recursive: true })
		return taskDir
	}

	private async getSavedApiConversationHistory(): Promise<Anthropic.MessageParam[]> {
		const filePath = path.join(await this.ensureTaskDirectoryExists(), GlobalFileNames.apiConversationHistory)
		const fileExists = await fileExistsAtPath(filePath)
		if (fileExists) {
			return JSON.parse(await fs.readFile(filePath, "utf8"))
		}
		return []
	}

	private async addToApiConversationHistory(message: Anthropic.MessageParam) {
		this.apiConversationHistory.push(message)
		await this.saveApiConversationHistory()
	}

	private async overwriteApiConversationHistory(newHistory: Anthropic.MessageParam[]) {
		this.apiConversationHistory = newHistory
		await this.saveApiConversationHistory()
	}

	private async saveApiConversationHistory() {
		try {
			const filePath = path.join(await this.ensureTaskDirectoryExists(), GlobalFileNames.apiConversationHistory)
			await fs.writeFile(filePath, JSON.stringify(this.apiConversationHistory))
		} catch (error) {
			// 在极少数情况下，如果失败，我们不希望停止任务
			console.error("保存 API 对话历史记录失败:", error)
		}
	}

	private async getSavedClineMessages(): Promise<ClineMessage[]> {
		const filePath = path.join(await this.ensureTaskDirectoryExists(), GlobalFileNames.uiMessages)
		if (await fileExistsAtPath(filePath)) {
			return JSON.parse(await fs.readFile(filePath, "utf8"))
		} else {
			// 检查旧位置
			const oldPath = path.join(await this.ensureTaskDirectoryExists(), "claude_messages.json")
			if (await fileExistsAtPath(oldPath)) {
				const data = JSON.parse(await fs.readFile(oldPath, "utf8"))
				await fs.unlink(oldPath) // 删除旧文件
				return data
			}
		}
		return []
	}

	private async addToClineMessages(message: ClineMessage) {
		// 这些值允许我们在创建此 cline 消息时重建对话历史记录
		// 在添加 cline 消息之前，初始化 apiConversationHistory 是很重要的
		message.conversationHistoryIndex = this.apiConversationHistory.length - 1 // 注意：这是最后添加的消息的索引，即用户消息，一旦 cline 消息被呈现，我们会用完成的助手消息更新 apiConversationHistory。这意味着在重置到消息时，我们需要 +1 这个索引以获得此工具使用对应的正确助手消息
		message.conversationHistoryDeletedRange = this.conversationHistoryDeletedRange
		this.clineMessages.push(message)
		await this.saveClineMessages()
	}

	private async overwriteClineMessages(newMessages: ClineMessage[]) {
		this.clineMessages = newMessages
		await this.saveClineMessages()
	}

	private async saveClineMessages() {
		try {
			const taskDir = await this.ensureTaskDirectoryExists()
			const filePath = path.join(taskDir, GlobalFileNames.uiMessages)
			await fs.writeFile(filePath, JSON.stringify(this.clineMessages))
			// 在 ChatView 中合并
			const apiMetrics = getApiMetrics(combineApiRequests(combineCommandSequences(this.clineMessages.slice(1))))
			const taskMessage = this.clineMessages[0] // 第一条消息总是任务说明
			const lastRelevantMessage =
				this.clineMessages[
					findLastIndex(this.clineMessages, (m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"))
				]
			let taskDirSize = 0
			try {
				// getFolderSize.loose 静默忽略错误
				// 返回字节数，size/1000/1000 = MB
				taskDirSize = await getFolderSize.loose(taskDir)
			} catch (error) {
				console.error("获取任务目录大小失败:", taskDir, error)
			}
			await this.providerRef.deref()?.updateTaskHistory({
				id: this.taskId,
				ts: lastRelevantMessage.ts,
				task: taskMessage.text ?? "",
				tokensIn: apiMetrics.totalTokensIn,
				tokensOut: apiMetrics.totalTokensOut,
				cacheWrites: apiMetrics.totalCacheWrites,
				cacheReads: apiMetrics.totalCacheReads,
				totalCost: apiMetrics.totalCost,
				size: taskDirSize,
				shadowGitConfigWorkTree: await this.checkpointTracker?.getShadowGitConfigWorkTree(),
				conversationHistoryDeletedRange: this.conversationHistoryDeletedRange,
			})
		} catch (error) {
			console.error("保存 cline 消息失败:", error)
		}
	}

	async restoreCheckpoint(messageTs: number, restoreType: ClineCheckpointRestore) {
		const messageIndex = this.clineMessages.findIndex((m) => m.ts === messageTs)
		const message = this.clineMessages[messageIndex]
		if (!message) {
			console.error("未找到消息", this.clineMessages)
			return
		}

		let didWorkspaceRestoreFail = false

		switch (restoreType) {
			case "task":
				break
			case "taskAndWorkspace":
			case "workspace":
				if (!this.checkpointTracker && !this.checkpointTrackerErrorMessage) {
					try {
						this.checkpointTracker = await CheckpointTracker.create(
							this.taskId,
							this.providerRef.deref()?.context.globalStorageUri.fsPath,
						)
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : "未知错误"
						console.error("初始化检查点跟踪器失败:", errorMessage)
						this.checkpointTrackerErrorMessage = errorMessage
						await this.providerRef.deref()?.postStateToWebview()
						vscode.window.showErrorMessage(errorMessage)
						didWorkspaceRestoreFail = true
					}
				}
				if (message.lastCheckpointHash && this.checkpointTracker) {
					try {
						await this.checkpointTracker.resetHead(message.lastCheckpointHash)
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : "未知错误"
						vscode.window.showErrorMessage("恢复检查点失败: " + errorMessage)
						didWorkspaceRestoreFail = true
					}
				}
				break
		}

		if (!didWorkspaceRestoreFail) {
			switch (restoreType) {
				case "task":
				case "taskAndWorkspace":
					this.conversationHistoryDeletedRange = message.conversationHistoryDeletedRange
					const newConversationHistory = this.apiConversationHistory.slice(
						0,
						(message.conversationHistoryIndex || 0) + 2,
					) // +1 因为这个索引对应于最后一个用户消息，再加上 +1 因为 slice 结束索引是排他的
					await this.overwriteApiConversationHistory(newConversationHistory)

					// 聚合删除的 api 请求信息，以免丢失成本/令牌
					const deletedMessages = this.clineMessages.slice(messageIndex + 1)
					const deletedApiReqsMetrics = getApiMetrics(combineApiRequests(combineCommandSequences(deletedMessages)))

					const newClineMessages = this.clineMessages.slice(0, messageIndex + 1)
					await this.overwriteClineMessages(newClineMessages) // 调用 saveClineMessages 保存 historyItem

					await this.say(
						"deleted_api_reqs",
						JSON.stringify({
							tokensIn: deletedApiReqsMetrics.totalTokensIn,
							tokensOut: deletedApiReqsMetrics.totalTokensOut,
							cacheWrites: deletedApiReqsMetrics.totalCacheWrites,
							cacheReads: deletedApiReqsMetrics.totalCacheReads,
							cost: deletedApiReqsMetrics.totalCost,
						} satisfies ClineApiReqInfo),
					)
					break
				case "workspace":
					break
			}

			switch (restoreType) {
				case "task":
					vscode.window.showInformationMessage("任务消息已恢复到检查点")
					break
				case "workspace":
					vscode.window.showInformationMessage("工作区文件已恢复到检查点")
					break
				case "taskAndWorkspace":
					vscode.window.showInformationMessage("任务和工作区已恢复到检查点")
					break
			}

			if (restoreType !== "task") {
				// 在消息上设置 isCheckpointCheckedOut 标志
				// 查找此消息之前的所有检查点消息
				const checkpointMessages = this.clineMessages.filter((m) => m.say === "checkpoint_created")
				const currentMessageIndex = checkpointMessages.findIndex((m) => m.ts === messageTs)

				// 将所有检查点消息的 isCheckpointCheckedOut 设置为 false
				checkpointMessages.forEach((m, i) => {
					m.isCheckpointCheckedOut = i === currentMessageIndex
				})
			}

			await this.saveClineMessages()

			await this.providerRef.deref()?.postMessageToWebview({ type: "relinquishControl" })

			this.providerRef.deref()?.cancelTask() // 任务已由提供者提前取消，但我们需要重新初始化以获取更新的消息
		} else {
			await this.providerRef.deref()?.postMessageToWebview({ type: "relinquishControl" })
		}
	}

	async presentMultifileDiff(messageTs: number, seeNewChangesSinceLastTaskCompletion: boolean) {
		const relinquishButton = () => {
			this.providerRef.deref()?.postMessageToWebview({ type: "relinquishControl" })
		}

		console.log("presentMultifileDiff", messageTs)
		const messageIndex = this.clineMessages.findIndex((m) => m.ts === messageTs)
		const message = this.clineMessages[messageIndex]
		if (!message) {
			console.error("未找到消息")
			relinquishButton()
			return
		}
		const hash = message.lastCheckpointHash
		if (!hash) {
			console.error("未找到检查点哈希")
			relinquishButton()
			return
		}

		// TODO: 处理如果这是从原始工作区外部调用的情况，在这种情况下我们需要向用户显示错误消息，我们无法在工作区外部显示差异？
		if (!this.checkpointTracker && !this.checkpointTrackerErrorMessage) {
			try {
				this.checkpointTracker = await CheckpointTracker.create(
					this.taskId,
					this.providerRef.deref()?.context.globalStorageUri.fsPath,
				)
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : "未知错误"
				console.error("初始化检查点跟踪器失败:", errorMessage)
				this.checkpointTrackerErrorMessage = errorMessage
				await this.providerRef.deref()?.postStateToWebview()
				vscode.window.showErrorMessage(errorMessage)
				relinquishButton()
				return
			}
		}

		let changedFiles:
			| {
					relativePath: string
					absolutePath: string
					before: string
					after: string
			  }[]
			| undefined

		try {
			if (seeNewChangesSinceLastTaskCompletion) {
				// 获取上次任务完成
				const lastTaskCompletedMessageCheckpointHash = findLast(
					this.clineMessages.slice(0, messageIndex),
					(m) => m.say === "completion_result",
				)?.lastCheckpointHash // ask 仅用于放弃控制，这是我们关心的最后一个 say
				// 如果未定义，则从 git 的开头获取差异
				// if (!lastTaskCompletedMessage) {
				// 	console.error("未找到上一个任务完成消息")
				// 	return
				// }
				// 此值应始终存在
				const firstCheckpointMessageCheckpointHash = this.clineMessages.find(
					(m) => m.say === "checkpoint_created",
				)?.lastCheckpointHash

				const previousCheckpointHash = lastTaskCompletedMessageCheckpointHash || firstCheckpointMessageCheckpointHash // 使用第一个检查点和任务完成之间的差异，或最新两个任务完成之间的差异

				if (!previousCheckpointHash) {
					vscode.window.showErrorMessage("意外错误：未找到检查点哈希")
					relinquishButton()
					return
				}

				// 获取当前状态和提交之间的更改文件
				changedFiles = await this.checkpointTracker?.getDiffSet(previousCheckpointHash, hash)
				if (!changedFiles?.length) {
					vscode.window.showInformationMessage("未找到更改")
					relinquishButton()
					return
				}
			} else {
				// 获取当前状态和提交之间的更改文件
				changedFiles = await this.checkpointTracker?.getDiffSet(hash)
				if (!changedFiles?.length) {
					vscode.window.showInformationMessage("未找到更改")
					relinquishButton()
					return
				}
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "未知错误"
			vscode.window.showErrorMessage("检索差异集失败: " + errorMessage)
			relinquishButton()
			return
		}

		// 检查 VS Code 设置中是否启用了多文件差异编辑器
		// const config = vscode.workspace.getConfiguration()
		// const isMultiDiffEnabled = config.get("multiDiffEditor.experimental.enabled")

		// if (!isMultiDiffEnabled) {
		// 	vscode.window.showErrorMessage(
		// 		"请在 VS Code 设置中启用 'multiDiffEditor.experimental.enabled' 以使用此功能。",
		// 	)
		// 	relinquishButton()
		// 	return
		// }
		// 打开多文件差异编辑器
		await vscode.commands.executeCommand(
			"vscode.changes",
			seeNewChangesSinceLastTaskCompletion ? "新更改" : "自快照以来的更改",
			changedFiles.map((file) => [
				vscode.Uri.file(file.absolutePath),
				vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${file.relativePath}`).with({
					query: Buffer.from(file.before ?? "").toString("base64"),
				}),
				vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${file.relativePath}`).with({
					query: Buffer.from(file.after ?? "").toString("base64"),
				}),
			]),
		)
		relinquishButton()
	}

	async doesLatestTaskCompletionHaveNewChanges() {
		const messageIndex = findLastIndex(this.clineMessages, (m) => m.say === "completion_result")
		const message = this.clineMessages[messageIndex]
		if (!message) {
			console.error("未找到完成消息")
			return false
		}
		const hash = message.lastCheckpointHash
		if (!hash) {
			console.error("未找到检查点哈希")
			return false
		}

		if (!this.checkpointTracker && !this.checkpointTrackerErrorMessage) {
			try {
				this.checkpointTracker = await CheckpointTracker.create(
					this.taskId,
					this.providerRef.deref()?.context.globalStorageUri.fsPath,
				)
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : "未知错误"
				console.error("初始化检查点跟踪器失败:", errorMessage)
				return false
			}
		}

		// 获取上次任务完成
		const lastTaskCompletedMessage = findLast(this.clineMessages.slice(0, messageIndex), (m) => m.say === "completion_result")

		try {
			// 获取上次任务完成
			const lastTaskCompletedMessageCheckpointHash = lastTaskCompletedMessage?.lastCheckpointHash // ask 仅用于放弃控制，这是我们关心的最后一个 say
			// 如果未定义，则从 git 的开头获取差异
			// if (!lastTaskCompletedMessage) {
			// 	console.error("未找到先前的任务完成消息")
			// 	return
			// }
			// 这个值 *应该* 始终存在
			const firstCheckpointMessageCheckpointHash = this.clineMessages.find(
				(m) => m.say === "checkpoint_created",
			)?.lastCheckpointHash

			// 要么使用第一个检查点和任务完成之间的差异，要么使用最近两次任务完成之间的差异
			const previousCheckpointHash = lastTaskCompletedMessageCheckpointHash || firstCheckpointMessageCheckpointHash

			if (!previousCheckpointHash) {
				return false
			}

			// 获取当前状态和提交之间更改的文件数量
			const changedFilesCount = (await this.checkpointTracker?.getDiffCount(previousCheckpointHash, hash)) || 0
			if (changedFilesCount > 0) {
				return true
			}
		} catch (error) {
			console.error("获取差异集失败:", error)
			return false
		}

		return false
	}

	// 与 webview 通信

	// partial 有三种有效状态：true（部分消息）、false（部分消息的完成）、undefined（单个完整消息）
	async ask(
		type: ClineAsk,
		text?: string,
		partial?: boolean,
	): Promise<{
		response: ClineAskResponse
		text?: string
		images?: string[]
	}> {
		// 如果此 Cline 实例被提供者中止，那么唯一让我们保持活动的是仍在后台运行的 promise，在这种情况下，我们不想将其结果发送到 webview，因为它现在附加到一个新的 Cline 实例。因此，我们可以安全地忽略任何活动 promise 的结果，并且该类将被释放。（尽管我们在提供者中设置 Cline = undefined，但这只是删除了对此实例的引用，但该实例在 promise 解决或拒绝之前仍然存在。）
		if (this.abort) {
			throw new Error("Cline 实例已中止")
		}
		let askTs: number
		if (partial !== undefined) {
			const lastMessage = this.clineMessages.at(-1)
			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "ask" && lastMessage.ask === type
			if (partial) {
				if (isUpdatingPreviousPartial) {
					// 现有部分消息，因此更新它
					lastMessage.text = text
					lastMessage.partial = partial
					// TODO：更有效地保存和发布，只发布新数据或一次发布整个消息，因此忽略部分保存，并且只发布部分消息的部分内容，而不是在新侦听器中发布整个数组
					// await this.saveClineMessages()
					// await this.providerRef.deref()?.postStateToWebview()
					await this.providerRef.deref()?.postMessageToWebview({
						type: "partialMessage",
						partialMessage: lastMessage,
					})
					throw new Error("当前的 ask promise 被忽略 1")
				} else {
					// 这是一个新的部分消息，因此使用部分状态添加它
					// this.askResponse = undefined
					// this.askResponseText = undefined
					// this.askResponseImages = undefined
					askTs = Date.now()
					this.lastMessageTs = askTs
					await this.addToClineMessages({
						ts: askTs,
						type: "ask",
						ask: type,
						text,
						partial,
					})
					await this.providerRef.deref()?.postStateToWebview()
					throw new Error("当前的 ask promise 被忽略 2")
				}
			} else {
				// partial=false 表示它是先前部分消息的完整版本
				if (isUpdatingPreviousPartial) {
					// 这是先前部分消息的完整版本，因此用完整版本替换部分版本
					this.askResponse = undefined
					this.askResponseText = undefined
					this.askResponseImages = undefined

					/*
					历史性的 Bug：
					在 webview 中，我们使用 ts 作为 virtuoso 列表的 chatrow 键。由于我们会在流式传输结束时更新此 ts，这会导致视图闪烁。key prop 必须稳定，否则 react 在渲染之间协调项目时会遇到麻烦，导致组件卸载和重新挂载（闪烁）。
					这里的教训是，如果在渲染列表时看到闪烁，很可能是因为 key prop 不稳定。
					因此，在这种情况下，我们必须确保消息 ts 在首次设置后永远不会被更改。
					*/
					askTs = lastMessage.ts
					this.lastMessageTs = askTs
					// lastMessage.ts = askTs
					lastMessage.text = text
					lastMessage.partial = false
					await this.saveClineMessages()
					// await this.providerRef.deref()?.postStateToWebview()
					await this.providerRef.deref()?.postMessageToWebview({
						type: "partialMessage",
						partialMessage: lastMessage,
					})
				} else {
					// 这是一个新的 partial=false 消息，因此像平常一样添加它
					this.askResponse = undefined
					this.askResponseText = undefined
					this.askResponseImages = undefined
					askTs = Date.now()
					this.lastMessageTs = askTs
					await this.addToClineMessages({
						ts: askTs,
						type: "ask",
						ask: type,
						text,
					})
					await this.providerRef.deref()?.postStateToWebview()
				}
			}
		} else {
			// 这是一个新的非部分消息，因此像平常一样添加它
			// const lastMessage = this.clineMessages.at(-1)
			this.askResponse = undefined
			this.askResponseText = undefined
			this.askResponseImages = undefined
			askTs = Date.now()
			this.lastMessageTs = askTs
			await this.addToClineMessages({
				ts: askTs,
				type: "ask",
				ask: type,
				text,
			})
			await this.providerRef.deref()?.postStateToWebview()
		}

		await pWaitFor(() => this.askResponse !== undefined || this.lastMessageTs !== askTs, { interval: 100 })
		if (this.lastMessageTs !== askTs) {
			// 如果我们连续发送多个 ask（例如使用 command_output），可能会发生这种情况。重要的是，当我们知道一个 ask 可能会失败时，要优雅地处理它
			throw new Error("当前的 ask promise 被忽略")
		}
		const result = {
			response: this.askResponse!,
			text: this.askResponseText,
			images: this.askResponseImages,
		}
		this.askResponse = undefined
		this.askResponseText = undefined
		this.askResponseImages = undefined
		return result
	}

	async handleWebviewAskResponse(askResponse: ClineAskResponse, text?: string, images?: string[]) {
		this.askResponse = askResponse
		this.askResponseText = text
		this.askResponseImages = images
	}

	async say(type: ClineSay, text?: string, images?: string[], partial?: boolean): Promise<undefined> {
		if (this.abort) {
			throw new Error("Cline 实例已中止")
		}

		if (partial !== undefined) {
			const lastMessage = this.clineMessages.at(-1)
			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "say" && lastMessage.say === type
			if (partial) {
				if (isUpdatingPreviousPartial) {
					// 现有部分消息，因此更新它
					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = partial
					await this.providerRef.deref()?.postMessageToWebview({
						type: "partialMessage",
						partialMessage: lastMessage,
					})
				} else {
					// 这是一个新的部分消息，因此使用部分状态添加它
					const sayTs = Date.now()
					this.lastMessageTs = sayTs
					await this.addToClineMessages({
						ts: sayTs,
						type: "say",
						say: type,
						text,
						images,
						partial,
					})
					await this.providerRef.deref()?.postStateToWebview()
				}
			} else {
				// partial=false 表示它是先前部分消息的完整版本
				if (isUpdatingPreviousPartial) {
					// 这是先前部分消息的完整版本，因此用完整版本替换部分版本
					this.lastMessageTs = lastMessage.ts
					// lastMessage.ts = sayTs
					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = false

					// 与其流式传输 partialMessage 事件，我们像平常一样进行保存和发布以持久化到磁盘
					await this.saveClineMessages()
					// await this.providerRef.deref()?.postStateToWebview()
					// 比整个 postStateToWebview 更高效
					await this.providerRef.deref()?.postMessageToWebview({
						type: "partialMessage",
						partialMessage: lastMessage,
					})
				} else {
					// 这是一个新的 partial=false 消息，因此像平常一样添加它
					const sayTs = Date.now()
					this.lastMessageTs = sayTs
					await this.addToClineMessages({
						ts: sayTs,
						type: "say",
						say: type,
						text,
						images,
					})
					await this.providerRef.deref()?.postStateToWebview()
				}
			}
		} else {
			// 这是一个新的非部分消息，因此像平常一样添加它
			const sayTs = Date.now()
			this.lastMessageTs = sayTs
			await this.addToClineMessages({
				ts: sayTs,
				type: "say",
				say: type,
				text,
				images,
			})
			await this.providerRef.deref()?.postStateToWebview()
		}
	}

	async sayAndCreateMissingParamError(toolName: ToolUseName, paramName: string, relPath?: string) {
		await this.say(
			"error",
			`Cline 尝试使用 ${toolName}${
				relPath ? ` 处理 '${relPath.toPosix()}'` : ""
			}，但缺少必需参数 '${paramName}' 的值。正在重试...`,
		)
		return formatResponse.toolError(formatResponse.missingToolParameterError(paramName))
	}

	async removeLastPartialMessageIfExistsWithType(type: "ask" | "say", askOrSay: ClineAsk | ClineSay) {
		const lastMessage = this.clineMessages.at(-1)
		if (lastMessage?.partial && lastMessage.type === type && (lastMessage.ask === askOrSay || lastMessage.say === askOrSay)) {
			this.clineMessages.pop()
			await this.saveClineMessages()
			await this.providerRef.deref()?.postStateToWebview()
		}
	}

	// 任务生命周期

	private async startTask(task?: string, images?: string[]): Promise<void> {
		// conversationHistory（用于 API）和 clineMessages（用于 webview）需要同步
		// 如果扩展进程被终止，那么在重新启动时 clineMessages 可能不为空，因此在创建新的 Cline 客户端时需要将其设置为空数组 []（否则 webview 会显示来自先前会话的过时消息）
		this.clineMessages = []
		this.apiConversationHistory = []

		await this.providerRef.deref()?.postStateToWebview()

		await this.say("text", task, images)

		this.isInitialized = true

		let imageBlocks: Anthropic.ImageBlockParam[] = formatResponse.imageBlocks(images)
		await this.initiateTaskLoop(
			[
				{
					type: "text",
					text: `<task>\n${task}\n</task>`,
				},
				...imageBlocks,
			],
			true,
		)
	}

	private async resumeTaskFromHistory() {
		// 更新：我们不再需要这个了，因为现在大多数任务都是在启用检查点的情况下创建的
		// 现在我们允许用户为旧任务初始化检查点，假设他们是从同一个工作区继续执行这些任务（我们从未将任务与工作区绑定，因此无法知道它是否在正确的工作区中打开）
		// const doesShadowGitExist = await CheckpointTracker.doesShadowGitExist(this.taskId, this.providerRef.deref())
		// if (!doesShadowGitExist) {
		// 	this.checkpointTrackerErrorMessage = "检查点仅适用于新任务"
		// }

		const modifiedClineMessages = await this.getSavedClineMessages()

		// 删除之前可能已添加的任何恢复消息
		const lastRelevantMessageIndex = findLastIndex(
			modifiedClineMessages,
			(m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"),
		)
		if (lastRelevantMessageIndex !== -1) {
			modifiedClineMessages.splice(lastRelevantMessageIndex + 1)
		}

		// 由于我们不再使用 api_req_finished，我们需要检查最后一个 api_req_started 是否有成本值，如果没有并且没有取消原因可呈现，那么我们将其删除，因为它表示一个没有任何部分内容流式传输的 api 请求
		const lastApiReqStartedIndex = findLastIndex(
			modifiedClineMessages,
			(m) => m.type === "say" && m.say === "api_req_started",
		)
		if (lastApiReqStartedIndex !== -1) {
			const lastApiReqStarted = modifiedClineMessages[lastApiReqStartedIndex]
			const { cost, cancelReason }: ClineApiReqInfo = JSON.parse(lastApiReqStarted.text || "{}")
			if (cost === undefined && cancelReason === undefined) {
				modifiedClineMessages.splice(lastApiReqStartedIndex, 1)
			}
		}

		await this.overwriteClineMessages(modifiedClineMessages)
		this.clineMessages = await this.getSavedClineMessages()

		// 现在向用户呈现 cline 消息并询问他们是否要恢复（注意：我们之前遇到过一个 bug，即在打开旧任务时 apiconversationhistory 不会初始化，这是因为我们在等待恢复）
		// 这很重要，以防用户在未先恢复任务的情况下删除消息
		this.apiConversationHistory = await this.getSavedApiConversationHistory()

		const lastClineMessage = this.clineMessages
			.slice()
			.reverse()
			// 可能是多个恢复任务
			.find((m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"))
		// const lastClineMessage = this.clineMessages[lastClineMessageIndex]
		// 可能是带有命令的完成结果
		// const secondLastClineMessage = this.clineMessages
		// 	.slice()
		// 	.reverse()
		// 	.find(
		// 		(m, index) =>
		// 			index !== lastClineMessageIndex && !(m.ask === "resume_task" || m.ask === "resume_completed_task")
		// 	)
		// (lastClineMessage?.ask === "command" && secondLastClineMessage?.ask === "completion_result")

		let askType: ClineAsk
		if (lastClineMessage?.ask === "completion_result") {
			askType = "resume_completed_task"
		} else {
			askType = "resume_task"
		}

		this.isInitialized = true

		// 调用 poststatetowebview
		const { response, text, images } = await this.ask(askType)
		let responseText: string | undefined
		let responseImages: string[] | undefined
		if (response === "messageResponse") {
			await this.say("user_feedback", text, images)
			responseText = text
			responseImages = images
		}

		// 需要确保 api 对话历史记录可以被 api 恢复，即使它与 cline 消息不同步

		const existingApiConversationHistory: Anthropic.Messages.MessageParam[] = await this.getSavedApiConversationHistory()

		// 如果最后一条消息是助手消息，我们需要检查是否有工具使用，因为每个工具使用都必须有工具响应
		// 如果没有工具使用且只有一个文本块，那么我们可以只添加一条用户消息
		// （注意：这不再相关，因为我们使用自定义工具提示而不是工具使用块，但这在这里是为了遗留目的，以防用户恢复旧任务）

		// 如果最后一条消息是用户消息，我们需要获取它之前的助手消息，以查看它是否进行了工具调用，如果是，则用 'interrupted' 填充剩余的工具响应

		// 如果是用户消息，则为最后一条消息，或者是最后一条（助手）消息之前的用户消息
		let modifiedOldUserContent: UserContent
		// 需要删除最后一条用户消息以替换为新的修改后的用户消息
		let modifiedApiConversationHistory: Anthropic.Messages.MessageParam[]
		if (existingApiConversationHistory.length > 0) {
			const lastMessage = existingApiConversationHistory[existingApiConversationHistory.length - 1]

			if (lastMessage.role === "assistant") {
				const content = Array.isArray(lastMessage.content)
					? lastMessage.content
					: [{ type: "text", text: lastMessage.content }]
				const hasToolUse = content.some((block) => block.type === "tool_use")

				if (hasToolUse) {
					const toolUseBlocks = content.filter(
						(block) => block.type === "tool_use",
					) as Anthropic.Messages.ToolUseBlock[]
					const toolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map((block) => ({
						type: "tool_result",
						tool_use_id: block.id,
						content: "在此工具调用完成之前任务被中断。",
					}))
					// 无更改
					modifiedApiConversationHistory = [...existingApiConversationHistory]
					modifiedOldUserContent = [...toolResponses]
				} else {
					modifiedApiConversationHistory = [...existingApiConversationHistory]
					modifiedOldUserContent = []
				}
			} else if (lastMessage.role === "user") {
				const previousAssistantMessage: Anthropic.Messages.MessageParam | undefined =
					existingApiConversationHistory[existingApiConversationHistory.length - 2]

				const existingUserContent: UserContent = Array.isArray(lastMessage.content)
					? lastMessage.content
					: [{ type: "text", text: lastMessage.content }]
				if (previousAssistantMessage && previousAssistantMessage.role === "assistant") {
					const assistantContent = Array.isArray(previousAssistantMessage.content)
						? previousAssistantMessage.content
						: [
								{
									type: "text",
									text: previousAssistantMessage.content,
								},
							]

					const toolUseBlocks = assistantContent.filter(
						(block) => block.type === "tool_use",
					) as Anthropic.Messages.ToolUseBlock[]

					if (toolUseBlocks.length > 0) {
						const existingToolResults = existingUserContent.filter(
							(block) => block.type === "tool_result",
						) as Anthropic.ToolResultBlockParam[]

						const missingToolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks
							.filter((toolUse) => !existingToolResults.some((result) => result.tool_use_id === toolUse.id))
							.map((toolUse) => ({
								type: "tool_result",
								tool_use_id: toolUse.id,
								content: "在此工具调用完成之前任务被中断。",
							}))

						// 删除最后一条用户消息
						modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
						modifiedOldUserContent = [...existingUserContent, ...missingToolResponses]
					} else {
						modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
						modifiedOldUserContent = [...existingUserContent]
					}
				} else {
					modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
					modifiedOldUserContent = [...existingUserContent]
				}
			} else {
				throw new Error("意外：最后一条消息不是用户或助手消息")
			}
		} else {
			throw new Error("意外：没有现有的 API 对话历史记录")
			// console.error("意外：没有现有的 API 对话历史记录")
			// modifiedApiConversationHistory = []
			// modifiedOldUserContent = []
		}

		let newUserContent: UserContent = [...modifiedOldUserContent]

		const agoText = (() => {
			const timestamp = lastClineMessage?.ts ?? Date.now()
			const now = Date.now()
			const diff = now - timestamp
			const minutes = Math.floor(diff / 60000)
			const hours = Math.floor(minutes / 60)
			const days = Math.floor(hours / 24)

			if (days > 0) {
				return `${days} 天前`
			}
			if (hours > 0) {
				return `${hours} 小时前`
			}
			if (minutes > 0) {
				return `${minutes} 分钟前`
			}
			return "刚刚"
		})()

		const wasRecent = lastClineMessage?.ts && Date.now() - lastClineMessage.ts < 30_000

		newUserContent.push({
			type: "text",
			text:
				`[任务恢复] ${
					this.chatSettings?.mode === "plan"
						? `此任务在 ${agoText} 被中断。对话可能不完整。请注意，项目状态可能自那时起已发生变化。当前工作目录现在是 '${cwd.toPosix()}'。\n\n注意：如果您之前尝试使用工具但用户未提供结果，则应假定工具使用未成功。但是您处于计划模式，因此您必须响应用户的消息，而不是继续执行任务。`
						: `此任务在 ${agoText} 被中断。它可能已完成，也可能未完成，因此请重新评估任务上下文。请注意，项目状态可能自那时起已发生变化。当前工作目录现在是 '${cwd.toPosix()}'。如果任务尚未完成，请重试中断前的最后一步，然后继续完成任务。\n\n注意：如果您之前尝试使用工具但用户未提供结果，则应假定工具使用未成功，并评估是否应重试。如果最后一个工具是 browser_action，则浏览器已关闭，如果需要，您必须启动新浏览器。`
				}${
					wasRecent
						? "\n\n重要提示：如果最后一次工具使用是 replace_in_file 或 write_to_file 并且被中断，则文件已恢复到中断编辑之前的原始状态，您无需重新读取文件，因为您已经拥有其最新内容。"
						: ""
				}` +
				(responseText
					? `\n\n${this.chatSettings?.mode === "plan" ? "使用 plan_mode_respond 工具响应的新消息（请确保在 <response> 参数中提供您的响应）" : "任务继续的新说明"}:\n<user_message>\n${responseText}\n</user_message>`
					: this.chatSettings.mode === "plan"
						? "(用户未提供新消息。请考虑询问他们希望如何进行，或切换到执行模式以继续任务。)"
						: ""),
		})

		if (responseImages && responseImages.length > 0) {
			newUserContent.push(...formatResponse.imageBlocks(responseImages))
		}

		await this.overwriteApiConversationHistory(modifiedApiConversationHistory)
		await this.initiateTaskLoop(newUserContent, false)
	}

	private async initiateTaskLoop(userContent: UserContent, isNewTask: boolean): Promise<void> {
		let nextUserContent = userContent
		let includeFileDetails = true
		while (!this.abort) {
			const didEndLoop = await this.recursivelyMakeClineRequests(nextUserContent, includeFileDetails, isNewTask)
			// 我们只需要第一次的文件详细信息
			includeFileDetails = false

			// 这个代理循环的工作方式是，cline 将被赋予一个任务，然后他调用工具来完成。除非有 attempt_completion 调用，否则我们会一直用他的工具响应来回应他，直到他 attempt_completion 或不再使用任何工具。如果他不再使用任何工具，我们会要求他考虑是否已完成任务，然后调用 attempt_completion，否则继续完成任务。
			// 有一个 MAX_REQUESTS_PER_TASK 限制以防止无限请求，但会提示 Cline 尽可能高效地完成任务。

			//const totalCost = this.calculateApiCost(totalInputTokens, totalOutputTokens)
			if (didEndLoop) {
				// 目前任务永远不会“完成”。这只会在用户达到最大请求数并拒绝重置计数时发生。
				//this.say("task_completed", `任务完成。总 API 使用成本：${totalCost}`)
				break
			} else {
				// this.say(
				// 	"tool",
				// 	"Cline 仅用文本块响应，但尚未调用 attempt_completion。强制他继续执行任务..."
				// )
				nextUserContent = [
					{
						type: "text",
						text: formatResponse.noToolsUsed(),
					},
				]
				this.consecutiveMistakeCount++
			}
		}
	}

	async abortTask() {
		// 将停止任何自主运行的 promise
		this.abort = true
		this.terminalManager.disposeAll()
		this.urlContentFetcher.closeBrowser()
		this.browserSession.closeBrowser()
		this.clineIgnoreController.dispose()
		// 需要等待，以便在从检查点重新启动任务之前确保目录/文件已恢复
		await this.diffViewProvider.revertChanges()
	}

	// 检查点

	async saveCheckpoint(isAttemptCompletionMessage: boolean = false) {
		// 将所有 checkpoint_created 消息的 isCheckpointCheckedOut 设置为 false
		this.clineMessages.forEach((message) => {
			if (message.say === "checkpoint_created") {
				message.isCheckpointCheckedOut = false
			}
		})

		if (!isAttemptCompletionMessage) {
			// 对于非尝试完成，我们只说检查点
			await this.say("checkpoint_created")
			// 目前静默失败
			this.checkpointTracker?.commit().then(async (commitHash) => {
				const lastCheckpointMessage = findLast(this.clineMessages, (m) => m.say === "checkpoint_created")
				if (lastCheckpointMessage) {
					lastCheckpointMessage.lastCheckpointHash = commitHash
					await this.saveClineMessages()
				}
			})

			//
		} else {
			// 尝试完成需要检查点同步，以便我们可以在 attempt_completion 后呈现按钮
			const commitHash = await this.checkpointTracker?.commit()
			// 对于 attempt_completion，找到最后一个 completion_result 消息并设置其检查点哈希。这将用于呈现“查看新更改”按钮
			const lastCompletionResultMessage = findLast(
				this.clineMessages,
				(m) => m.say === "completion_result" || m.ask === "completion_result",
			)
			if (lastCompletionResultMessage) {
				lastCompletionResultMessage.lastCheckpointHash = commitHash
				await this.saveClineMessages()
			}
		}

		// if (commitHash) {

		// 以前我们为每条消息都设置了检查点，但这过于繁琐且不必要。
		// // 从末尾开始向后查找，直到找到工具使用或带有哈希的另一条消息
		// for (let i = this.clineMessages.length - 1; i >= 0; i--) {
		// 	const message = this.clineMessages[i]
		// 	if (message.lastCheckpointHash) {
		// 		// 找到带有哈希的消息，可以停止
		// 		break
		// 	}
		// 	// 使用哈希更新此消息
		// 	message.lastCheckpointHash = commitHash

		// 	// 我们只关心将哈希添加到最后一个工具使用（我们不想将此哈希添加到每个先前的消息，例如对于检查点之前的任务）
		// 	const isToolUse =
		// 		message.say === "tool" ||
		// 		message.ask === "tool" ||
		// 		message.say === "command" ||
		// 		message.ask === "command" ||
		// 		message.say === "completion_result" ||
		// 		message.ask === "completion_result" ||
		// 		message.ask === "followup" ||
		// 		message.say === "use_mcp_server" ||
		// 		message.ask === "use_mcp_server" ||
		// 		message.say === "browser_action" ||
		// 		message.say === "browser_action_launch" ||
		// 		message.ask === "browser_action_launch"

		// 	if (isToolUse) {
		// 		break
		// 	}
		// }
		// // 保存更新后的消息
		// await this.saveClineMessages()
		// }
	}

	// 工具

	async executeCommandTool(command: string): Promise<[boolean, ToolResponse]> {
		const terminalInfo = await this.terminalManager.getOrCreateTerminal(cwd)
		// 创建新终端（即使是手动创建）时出现的奇怪视觉错误，顶部有一个空白区域。
		terminalInfo.terminal.show()
		const process = this.terminalManager.runCommand(terminalInfo, command)

		let userFeedback: { text?: string; images?: string[] } | undefined
		let didContinue = false
		const sendCommandOutput = async (line: string): Promise<void> => {
			try {
				const { response, text, images } = await this.ask("command_output", line)
				if (response === "yesButtonClicked") {
					// 运行时继续
				} else {
					userFeedback = { text, images }
				}
				didContinue = true
				// 继续执行 await 之后的操作
				process.continue()
			} catch {
				// 只有当这个 ask promise 被忽略时才会发生这种情况，所以忽略这个错误
			}
		}

		let result = ""
		process.on("line", (line) => {
			result += line + "\n"
			if (!didContinue) {
				sendCommandOutput(line)
			} else {
				this.say("command_output", line)
			}
		})

		let completed = false
		process.once("completed", () => {
			completed = true
		})

		process.once("no_shell_integration", async () => {
			await this.say("shell_integration_warning")
		})

		await process

		// 等待一小段时间以确保所有消息都发送到 webview
		// 这个延迟允许时间创建非等待的 promise
		// 并将其关联的消息发送到 webview，从而保持
		// 消息的正确顺序（尽管 webview 很智能
		// 无论如何都会对 command_output 消息进行分组，即使存在间隙）
		await setTimeoutPromise(50)

		result = result.trim()

		if (userFeedback) {
			await this.say("user_feedback", userFeedback.text, userFeedback.images)
			return [
				true,
				formatResponse.toolResult(
					`命令仍在用户的终端中运行。${
						result.length > 0 ? `\n这是到目前为止的输出：\n${result}` : ""
					}\n\n用户提供了以下反馈：\n<feedback>\n${userFeedback.text}\n</feedback>`,
					userFeedback.images,
				),
			]
		}

		if (completed) {
			return [false, `命令已执行。${result.length > 0 ? `\n输出：\n${result}` : ""}`]
		} else {
			return [
				false,
				`命令仍在用户的终端中运行。${
					result.length > 0 ? `\n这是到目前为止的输出：\n${result}` : ""
				}\n\n将来会向您更新终端状态和新输出。`,
			]
		}
	}

	shouldAutoApproveTool(toolName: ToolUseName): boolean {
		if (this.autoApprovalSettings.enabled) {
			switch (toolName) {
				case "read_file":
				case "list_files":
				case "list_code_definition_names":
				case "search_files":
					return this.autoApprovalSettings.actions.readFiles
				case "write_to_file":
				case "replace_in_file":
					return this.autoApprovalSettings.actions.editFiles
				case "execute_command":
					return this.autoApprovalSettings.actions.executeCommands
				case "browser_action":
					return this.autoApprovalSettings.actions.useBrowser
				case "access_mcp_resource":
				case "use_mcp_tool":
					return this.autoApprovalSettings.actions.useMcp
			}
		}
		return false
	}

	private formatErrorWithStatusCode(error: any): string {
		const statusCode = error.status || error.statusCode || (error.response && error.response.status)
		const message = error.message ?? JSON.stringify(serializeError(error), null, 2)

		// 仅在状态码尚未包含在消息中时才在前面添加状态码
		return statusCode && !message.includes(statusCode.toString()) ? `${statusCode} - ${message}` : message
	}

	async *attemptApiRequest(previousApiReqIndex: number): ApiStream {
		// 在生成系统提示之前等待 MCP 服务器连接
		await pWaitFor(() => this.providerRef.deref()?.mcpHub?.isConnecting !== true, { timeout: 10_000 }).catch(() => {
			console.error("MCP 服务器连接超时")
		})

		const mcpHub = this.providerRef.deref()?.mcpHub
		if (!mcpHub) {
			throw new Error("MCP hub 不可用")
		}

		const disableBrowserTool = vscode.workspace.getConfiguration("cline").get<boolean>("disableBrowserTool") ?? false
		const modelSupportsComputerUse = this.api.getModel().info.supportsComputerUse ?? false

		const supportsComputerUse = modelSupportsComputerUse && !disableBrowserTool // 仅当模型支持且用户未禁用时才启用计算机使用

		let systemPrompt = await SYSTEM_PROMPT(cwd, supportsComputerUse, mcpHub, this.browserSettings)

		let settingsCustomInstructions = this.customInstructions?.trim()
		const preferredLanguage = getLanguageKey(
			vscode.workspace.getConfiguration("cline").get<LanguageDisplay>("preferredLanguage"),
		)
		const preferredLanguageInstructions =
			preferredLanguage && preferredLanguage !== DEFAULT_LANGUAGE_SETTINGS
				? `# 首选语言\n\n使用 ${preferredLanguage} 交流。`
				: ""
		const clineRulesFilePath = path.resolve(cwd, GlobalFileNames.clineRules)
		let clineRulesFileInstructions: string | undefined
		if (await fileExistsAtPath(clineRulesFilePath)) {
			if (await isDirectory(clineRulesFilePath)) {
				try {
					// 读取 .clinerules/ 目录中的所有文件
					const ruleFiles = await fs
						.readdir(clineRulesFilePath, { withFileTypes: true, recursive: true })
						.then((files) => files.filter((file) => file.isFile()))
						.then((files) => files.map((file) => path.resolve(file.parentPath, file.name)))
					const ruleFileContent = await Promise.all(
						ruleFiles.map(async (file) => {
							const ruleFilePath = path.resolve(clineRulesFilePath, file)
							const ruleFilePathRelative = path.relative(cwd, ruleFilePath)
							return `${ruleFilePathRelative}\n` + (await fs.readFile(ruleFilePath, "utf8")).trim()
						}),
					).then((contents) => contents.join("\n\n"))
					clineRulesFileInstructions = `# .clinerules/\n\n以下内容由根级 .clinerules/ 目录提供，用户在其中为此工作目录 (${cwd.toPosix()}) 指定了指令\n\n${ruleFileContent}`
				} catch {
					console.error(`读取 .clinerules 目录失败：${clineRulesFilePath}`)
				}
			} else {
				try {
					const ruleFileContent = (await fs.readFile(clineRulesFilePath, "utf8")).trim()
					if (ruleFileContent) {
						clineRulesFileInstructions = `# .clinerules\n\n以下内容由根级 .clinerules 文件提供，用户在其中为此工作目录 (${cwd.toPosix()}) 指定了指令\n\n${ruleFileContent}`
					}
				} catch {
					console.error(`读取 .clinerules 文件失败：${clineRulesFilePath}`)
				}
			}
		}

		const clineIgnoreContent = this.clineIgnoreController.clineIgnoreContent
		let clineIgnoreInstructions: string | undefined
		if (clineIgnoreContent) {
			clineIgnoreInstructions = `# .clineignore\n\n(以下内容由根级 .clineignore 文件提供，用户在其中指定了不应访问的文件和目录。使用 list_files 时，您会注意到被阻止的文件旁边有 ${LOCK_TEXT_SYMBOL}。尝试通过 read_file 等方式访问文件内容将导致错误。)\n\n${clineIgnoreContent}\n.clineignore`
		}

		if (
			settingsCustomInstructions ||
			clineRulesFileInstructions ||
			clineIgnoreInstructions ||
			preferredLanguageInstructions
		) {
			// 在任务中途更改系统提示将破坏提示缓存，但总体而言，这不会经常更改，因此最好不要用它污染用户消息，就像我们必须对<potentially relevant details>做的那样
			systemPrompt += addUserInstructions(
				settingsCustomInstructions,
				clineRulesFileInstructions,
				clineIgnoreInstructions,
				preferredLanguageInstructions,
			)
		}
		const contextManagementMetadata = this.contextManager.getNewContextMessagesAndMetadata(
			this.apiConversationHistory,
			this.clineMessages,
			this.api,
			this.conversationHistoryDeletedRange,
			previousApiReqIndex,
		)

		if (contextManagementMetadata.updatedConversationHistoryDeletedRange) {
			this.conversationHistoryDeletedRange = contextManagementMetadata.conversationHistoryDeletedRange
			await this.saveClineMessages() // 保存任务历史项，我们用它来跟踪对话历史删除范围
		}

		let stream = this.api.createMessage(systemPrompt, contextManagementMetadata.truncatedConversationHistory)

		const iterator = stream[Symbol.asyncIterator]()

		try {
			// 等待第一个数据块，看看是否会抛出错误
			this.isWaitingForFirstChunk = true
			const firstChunk = await iterator.next()
			yield firstChunk.value
			this.isWaitingForFirstChunk = false
		} catch (error) {
			const isOpenRouter = this.api instanceof OpenRouterHandler || this.api instanceof ClineHandler
			const isAnthropic = this.api instanceof AnthropicHandler
			const isOpenRouterContextWindowError = checkIsOpenRouterContextWindowError(error) && isOpenRouter
			const isAnthropicContextWindowError = checkIsAnthropicContextWindowError(error) && isAnthropic

			if (isAnthropic && isAnthropicContextWindowError && !this.didAutomaticallyRetryFailedApiRequest) {
				this.conversationHistoryDeletedRange = this.contextManager.getNextTruncationRange(
					this.apiConversationHistory,
					this.conversationHistoryDeletedRange,
					"quarter", // 强制激进截断
				)
				await this.saveClineMessages()

				this.didAutomaticallyRetryFailedApiRequest = true
			} else if (isOpenRouter && !this.didAutomaticallyRetryFailedApiRequest) {
				if (isOpenRouterContextWindowError) {
					this.conversationHistoryDeletedRange = this.contextManager.getNextTruncationRange(
						this.apiConversationHistory,
						this.conversationHistoryDeletedRange,
						"quarter", // 强制激进截断
					)
					await this.saveClineMessages()
				}

				console.log("第一个数据块失败，等待1秒后重试")
				await setTimeoutPromise(1000)
				this.didAutomaticallyRetryFailedApiRequest = true
			} else {
				// 在自动重试一次后请求仍然失败，询问用户是否要再次重试
				// 注意，这个 api_req_failed 询问是独特的，因为我们只在 API 尚未流式传输任何内容时（即由于第一个数据块失败）才提供此选项，这将允许他们点击重试按钮。但是，如果 API 在流式传输过程中失败，它可能处于任意状态，其中一些工具可能已经执行，因此该错误的处理方式不同，需要完全取消任务。

				if (isOpenRouterContextWindowError || isAnthropicContextWindowError) {
					const truncatedConversationHistory = this.contextManager.getTruncatedMessages(
						this.apiConversationHistory,
						this.conversationHistoryDeletedRange,
					)

					// 如果对话有超过3条消息，我们可以再次截断。如果没有，那么对话就无法继续。
					// 待办：如果是这种情况，允许用户更改输入。
					if (truncatedConversationHistory.length > 3) {
						error = new Error("上下文窗口超出限制。点击重试以截断对话并再次尝试。")
						this.didAutomaticallyRetryFailedApiRequest = false
					}
				}

				const errorMessage = this.formatErrorWithStatusCode(error)

				const { response } = await this.ask("api_req_failed", errorMessage)

				if (response !== "yesButtonClicked") {
					// 这永远不会发生，因为如果点击了 noButtonClicked，我们将清除当前任务，中止此实例
					throw new Error("API 请求失败")
				}

				await this.say("api_req_retried")
			}
			// 从递归调用中委托生成器输出
			yield* this.attemptApiRequest(previousApiReqIndex)
			return
		}

		// 没有错误，所以我们可以继续产生所有剩余的数据块
		// (需要放在 try/catch 之外，因为我们希望调用者处理错误，而不是使用 api_req_failed，因为它仅保留用于第一个数据块失败)
		// 这将委托给另一个生成器或可迭代对象。在这种情况下，它表示"从这个迭代器中产生所有剩余的值"。这有效地传递了原始流中的所有后续数据块。
		yield* iterator
	}

	async presentAssistantMessage() {
		if (this.abort) {
			throw new Error("Cline 实例已中止")
		}

		if (this.presentAssistantMessageLocked) {
			this.presentAssistantMessageHasPendingUpdates = true
			return
		}
		this.presentAssistantMessageLocked = true
		this.presentAssistantMessageHasPendingUpdates = false

		if (this.currentStreamingContentIndex >= this.assistantMessageContent.length) {
			// 如果最后一个内容块在流式传输完成之前就已完成，则可能会发生这种情况。如果流式传输已完成，并且我们超出了边界，那么这意味着我们已经呈现/执行了最后一个内容块，并准备继续下一个请求
			if (this.didCompleteReadingStream) {
				this.userMessageContentReady = true
			}
			// console.log("没有更多内容块可流式传输！这不应该发生？")
			this.presentAssistantMessageLocked = false
			return
			//throw new Error("没有更多内容块可流式传输！这不应该发生...") // 测试后删除并只返回
		}

		const block = cloneDeep(this.assistantMessageContent[this.currentStreamingContentIndex]) // 需要创建副本，因为在流更新数组时，它也可能更新引用块属性
		switch (block.type) {
			case "text": {
				if (this.didRejectTool || this.didAlreadyUseTool) {
					break
				}
				let content = block.content
				if (content) {
					// (对部分和完整都必须这样做，因为将内容发送到思考标签中的 markdown 渲染器会自动删除)
					// 删除 <thinking 或 </thinking 的结束子字符串（下面的 xml 解析仅适用于开始标签）
					// (现在使用下面的 xml 解析完成，但保留在此处作为参考)
					// content = content.replace(/<\/?t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?)?)?$/, "")
					// 删除所有 <thinking>（后面可选换行）和 </thinking>（前面可选换行）实例
					// - 需要分开，因为我们不想删除第一个标签前的换行符
					// - 需要在下面的 xml 解析之前进行
					content = content.replace(/<thinking>\s?/g, "")
					content = content.replace(/\s?<\/thinking>/g, "")

					// 删除内容最末尾的部分 XML 标签（用于工具使用和思考标签）
					// (防止在自动删除标签时滚动视图跳转)
					const lastOpenBracketIndex = content.lastIndexOf("<")
					if (lastOpenBracketIndex !== -1) {
						const possibleTag = content.slice(lastOpenBracketIndex)
						// 检查最后一个 '<' 后是否有 '>'（即标签是否完整）（完整的思考和工具标签现在应该已被删除）
						const hasCloseBracket = possibleTag.includes(">")
						if (!hasCloseBracket) {
							// 提取潜在的标签名
							let tagContent: string
							if (possibleTag.startsWith("</")) {
								tagContent = possibleTag.slice(2).trim()
							} else {
								tagContent = possibleTag.slice(1).trim()
							}
							// 检查 tagContent 是否可能是不完整的标签名（仅字母和下划线）
							const isLikelyTagName = /^[a-zA-Z_]+$/.test(tagContent)
							// 预先删除 < 或 </ 以防止这些工件显示在聊天中（也处理关闭思考标签）
							const isOpeningOrClosing = possibleTag === "<" || possibleTag === "</"
							// 如果标签不完整且在末尾，则从内容中删除
							if (isOpeningOrClosing || isLikelyTagName) {
								content = content.slice(0, lastOpenBracketIndex).trim()
							}
						}
					}
				}

				if (!block.partial) {
					// 一些模型在工具调用周围添加代码块工件，这些工件会出现在文本内容的末尾
					// 匹配字符串末尾的 ``` 后至少有一个字符
					const match = content?.trimEnd().match(/```[a-zA-Z0-9_-]+$/)
					if (match) {
						const matchLength = match[0].length
						content = content.trimEnd().slice(0, -matchLength)
					}
				}

				await this.say("text", content, undefined, block.partial)
				break
			}
			case "tool_use":
				const toolDescription = () => {
					switch (block.name) {
						case "execute_command":
							return `[${block.name} 用于 '${block.params.command}']`
						case "read_file":
							return `[${block.name} 用于 '${block.params.path}']`
						case "write_to_file":
							return `[${block.name} 用于 '${block.params.path}']`
						case "replace_in_file":
							return `[${block.name} 用于 '${block.params.path}']`
						case "search_files":
							return `[${block.name} 用于 '${block.params.regex}'${
								block.params.file_pattern ? ` 在 '${block.params.file_pattern}' 中` : ""
							}]`
						case "list_files":
							return `[${block.name} 用于 '${block.params.path}']`
						case "list_code_definition_names":
							return `[${block.name} 用于 '${block.params.path}']`
						case "browser_action":
							return `[${block.name} 用于 '${block.params.action}']`
						case "use_mcp_tool":
							return `[${block.name} 用于 '${block.params.server_name}']`
						case "access_mcp_resource":
							return `[${block.name} 用于 '${block.params.server_name}']`
						case "ask_followup_question":
							return `[${block.name} 用于 '${block.params.question}']`
						case "plan_mode_respond":
							return `[${block.name}]`
						case "attempt_completion":
							return `[${block.name}]`
					}
				}

				if (this.didRejectTool) {
					// 用户拒绝工具后忽略任何工具内容
					if (!block.partial) {
						this.userMessageContent.push({
							type: "text",
							text: `跳过工具 ${toolDescription()}，因为用户拒绝了之前的工具。`,
						})
					} else {
						// 用户拒绝之前工具后的部分工具
						this.userMessageContent.push({
							type: "text",
							text: `工具 ${toolDescription()} 被中断且未执行，因为用户拒绝了之前的工具。`,
						})
					}
					break
				}

				if (this.didAlreadyUseTool) {
					// 工具已使用后忽略任何内容
					this.userMessageContent.push({
						type: "text",
						text: `工具 [${block.name}] 未执行，因为此消息中已使用了一个工具。每条消息只能使用一个工具。您必须先评估第一个工具的结果，然后才能使用下一个工具。`,
					})
					break
				}

				const pushToolResult = (content: ToolResponse) => {
					this.userMessageContent.push({
						type: "text",
						text: `${toolDescription()} 结果：`,
					})
					if (typeof content === "string") {
						this.userMessageContent.push({
							type: "text",
							text: content || "(工具未返回任何内容)",
						})
					} else {
						this.userMessageContent.push(...content)
					}
					// 一旦收集了工具结果，就忽略所有其他工具使用，因为我们每条消息应该只呈现一个工具结果
					this.didAlreadyUseTool = true
				}

				// 用户可以批准、拒绝或提供反馈（拒绝）。但是，用户也可能在批准的同时发送消息，在这种情况下，我们会添加一个带有此反馈的单独用户消息。
				const pushAdditionalToolFeedback = (feedback?: string, images?: string[]) => {
					if (!feedback && !images) {
						return
					}
					const content = formatResponse.toolResult(
						`用户提供了以下反馈：\n<feedback>\n${feedback}\n</feedback>`,
						images,
					)
					if (typeof content === "string") {
						this.userMessageContent.push({
							type: "text",
							text: content,
						})
					} else {
						this.userMessageContent.push(...content)
					}
				}

				const askApproval = async (type: ClineAsk, partialMessage?: string) => {
					const { response, text, images } = await this.ask(type, partialMessage, false)
					if (response !== "yesButtonClicked") {
						// 用户按下拒绝按钮或回复了消息，我们将其视为拒绝
						pushToolResult(formatResponse.toolDenied())
						if (text || images?.length) {
							pushAdditionalToolFeedback(text, images)
							await this.say("user_feedback", text, images)
						}
						this.didRejectTool = true // 防止此消息中进一步使用工具
						return false
					} else {
						// 用户点击了批准按钮，并可能提供了反馈
						if (text || images?.length) {
							pushAdditionalToolFeedback(text, images)
							await this.say("user_feedback", text, images)
						}
						return true
					}
				}

				const showNotificationForApprovalIfAutoApprovalEnabled = (message: string) => {
					if (this.autoApprovalSettings.enabled && this.autoApprovalSettings.enableNotifications) {
						showSystemNotification({
							subtitle: "需要批准",
							message,
						})
					}
				}

				const handleError = async (action: string, error: Error) => {
					if (this.abandoned) {
						console.log("忽略错误，因为任务已被放弃（即任务取消后重置）")
						return
					}
					const errorString = `${action}错误：${JSON.stringify(serializeError(error))}`
					await this.say("error", `${action}错误：\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`)
					// this.toolResults.push({
					// 	type: "tool_result",
					// 	tool_use_id: toolUseId,
					// 	content: await this.formatToolError(errorString),
					// })
					pushToolResult(formatResponse.toolError(errorString))
				}

				// 如果块是部分的，删除部分关闭标签，使其不呈现给用户
				const removeClosingTag = (tag: ToolParamName, text?: string) => {
					if (!block.partial) {
						return text || ""
					}
					if (!text) {
						return ""
					}
					// 此正则表达式动态构建一个模式来匹配关闭标签：
					// - 可选匹配标签前的空白
					// - 匹配 '<' 或 '</' 后面可选跟随标签名称的任何子集字符
					const tagRegex = new RegExp(
						`\\s?<\/?${tag
							.split("")
							.map((char) => `(?:${char})?`)
							.join("")}$`,
						"g",
					)
					return text.replace(tagRegex, "")
				}

				if (block.name !== "browser_action") {
					await this.browserSession.closeBrowser()
				}

				switch (block.name) {
					case "write_to_file":
					case "replace_in_file": {
						const relPath: string | undefined = block.params.path
						let content: string | undefined = block.params.content // 用于 write_to_file
						let diff: string | undefined = block.params.diff // 用于 replace_in_file
						if (!relPath || (!content && !diff)) {
							// 检查 content/diff 确保 relPath 是完整的
							// 等待以确定是新文件还是编辑现有文件
							break
						}

						const accessAllowed = this.clineIgnoreController.validateAccess(relPath)
						if (!accessAllowed) {
							await this.say("clineignore_error", relPath)
							pushToolResult(formatResponse.toolError(formatResponse.clineIgnoreError(relPath)))

							break
						}

						// 使用缓存映射或 fs.access 检查文件是否存在
						let fileExists: boolean
						if (this.diffViewProvider.editType !== undefined) {
							fileExists = this.diffViewProvider.editType === "modify"
						} else {
							const absolutePath = path.resolve(cwd, relPath)
							fileExists = await fileExistsAtPath(absolutePath)
							this.diffViewProvider.editType = fileExists ? "modify" : "create"
						}

						try {
							// 从差异构造新内容
							let newContent: string
							if (diff) {
								if (!this.api.getModel().id.includes("claude")) {
									// deepseek 模型倾向于在差异中使用未转义的 html 实体
									diff = fixModelHtmlEscaping(diff)
									diff = removeInvalidChars(diff)
								}

								// 如果尚未打开编辑器，则打开它。这是为了修复当模型提供正确的搜索替换文本但 Cline 抛出错误时的差异错误
								// 因为文件未打开。
								if (!this.diffViewProvider.isEditing) {
									await this.diffViewProvider.open(relPath)
								}

								try {
									newContent = await constructNewFileContent(
										diff,
										this.diffViewProvider.originalContent || "",
										!block.partial,
									)
								} catch (error) {
									await this.say("diff_error", relPath)
									pushToolResult(
										formatResponse.toolError(
											`${(error as Error)?.message}\n\n` +
												`这可能是因为 SEARCH 块内容与文件中的内容不完全匹配，或者如果您使用了多个 SEARCH/REPLACE 块，它们可能不是按照它们在文件中出现的顺序排列的。\n\n` +
												`文件已恢复到其原始状态：\n\n` +
												`<file_content path="${relPath.toPosix()}">\n${this.diffViewProvider.originalContent}\n</file_content>\n\n` +
												`尝试使用更少/更精确的 SEARCH 块。\n(如果您连续两次遇到此错误，可以使用 write_to_file 工具作为备选方案。)`,
										),
									)
									await this.diffViewProvider.revertChanges()
									await this.diffViewProvider.reset()
									break
								}
							} else if (content) {
								newContent = content

								// 预处理 newContent，处理较弱模型可能添加的工件，如 markdown 代码块标记（deepseek/llama）或额外的转义字符（gemini）
								if (newContent.startsWith("```")) {
									// 这处理包含语言说明符的情况，如 ```python ```js
									newContent = newContent.split("\n").slice(1).join("\n").trim()
								}
								if (newContent.endsWith("```")) {
									newContent = newContent.split("\n").slice(0, -1).join("\n").trim()
								}

								if (!this.api.getModel().id.includes("claude")) {
									// 似乎不仅仅是 llama 模型在这样做，gemini 和其他模型也可能这样做
									newContent = fixModelHtmlEscaping(newContent)
									newContent = removeInvalidChars(newContent)
								}
							} else {
								// 不可能发生，因为我们已经在上面检查了 content/diff。但需要这样做以避免类型错误
								break
							}

							newContent = newContent.trimEnd() // 删除任何尾随换行符，因为编辑器会自动插入

							const sharedMessageProps: ClineSayTool = {
								tool: fileExists ? "editedExistingFile" : "newFileCreated",
								path: getReadablePath(cwd, removeClosingTag("path", relPath)),
								content: diff || content,
							}

							if (block.partial) {
								// 更新 GUI 消息
								const partialMessage = JSON.stringify(sharedMessageProps)
								if (this.shouldAutoApproveTool(block.name)) {
									this.removeLastPartialMessageIfExistsWithType("ask", "tool") // 以防用户在流式传输过程中更改自动批准设置
									await this.say("tool", partialMessage, undefined, block.partial)
								} else {
									this.removeLastPartialMessageIfExistsWithType("say", "tool")
									await this.ask("tool", partialMessage, block.partial).catch(() => {})
								}
								// update editor
								if (!this.diffViewProvider.isEditing) {
									// open the editor and prepare to stream content in
									await this.diffViewProvider.open(relPath)
								}
								// editor is open, stream content in
								await this.diffViewProvider.update(newContent, false)
								break
							} else {
								if (!relPath) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError(block.name, "path"))
									await this.diffViewProvider.reset()

									break
								}
								if (block.name === "replace_in_file" && !diff) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("replace_in_file", "diff"))
									await this.diffViewProvider.reset()

									break
								}
								if (block.name === "write_to_file" && !content) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("write_to_file", "content"))
									await this.diffViewProvider.reset()

									break
								}

								this.consecutiveMistakeCount = 0

								// if isEditingFile false, that means we have the full contents of the file already.
								// it's important to note how this function works, you can't make the assumption that the block.partial conditional will always be called since it may immediately get complete, non-partial data. So this part of the logic will always be called.
								// in other words, you must always repeat the block.partial logic here
								if (!this.diffViewProvider.isEditing) {
									// show gui message before showing edit animation
									const partialMessage = JSON.stringify(sharedMessageProps)
									await this.ask("tool", partialMessage, true).catch(() => {}) // sending true for partial even though it's not a partial, this shows the edit row before the content is streamed into the editor
									await this.diffViewProvider.open(relPath)
								}
								await this.diffViewProvider.update(newContent, true)
								await setTimeoutPromise(300) // wait for diff view to update
								this.diffViewProvider.scrollToFirstDiff()
								// showOmissionWarning(this.diffViewProvider.originalContent || "", newContent)

								const completeMessage = JSON.stringify({
									...sharedMessageProps,
									content: diff || content,
									// ? formatResponse.createPrettyPatch(
									// 		relPath,
									// 		this.diffViewProvider.originalContent,
									// 		newContent,
									// 	)
									// : undefined,
								} satisfies ClineSayTool)

								if (this.shouldAutoApproveTool(block.name)) {
									this.removeLastPartialMessageIfExistsWithType("ask", "tool")
									await this.say("tool", completeMessage, undefined, false)
									this.consecutiveAutoApprovedRequestsCount++
									telemetryService.captureToolUsage(this.taskId, block.name, true, true)

									// 我们需要一个人为的延迟，让诊断信息跟上变化
									await setTimeoutPromise(3_500)
								} else {
									// 如果启用了自动批准，但此工具未被自动批准，则发送通知
									showNotificationForApprovalIfAutoApprovalEnabled(
										`Cline 想要 ${fileExists ? "编辑" : "创建"} ${path.basename(relPath)}`,
									)
									this.removeLastPartialMessageIfExistsWithType("say", "tool")

									// 文件编辑需要更定制化的工具响应，以突出文件未被更新的事实（这对 deepseek 尤其重要）
									let didApprove = true
									const { response, text, images } = await this.ask("tool", completeMessage, false)
									if (response !== "yesButtonClicked") {
										// 用户发送了消息或按下了拒绝按钮
										// TODO: 为其他工具拒绝响应添加类似上下文，以强调例如命令未运行
										const fileDeniedNote = fileExists ? "文件未被更新，并保持其原始内容。" : "文件未被创建。"
										pushToolResult(`用户拒绝了此操作。 ${fileDeniedNote}`)
										if (text || images?.length) {
											pushAdditionalToolFeedback(text, images)
											await this.say("user_feedback", text, images)
										}
										this.didRejectTool = true
										didApprove = false
										telemetryService.captureToolUsage(this.taskId, block.name, false, false)
									} else {
										// 用户点击了批准按钮，并且可能提供了反馈
										if (text || images?.length) {
											pushAdditionalToolFeedback(text, images)
											await this.say("user_feedback", text, images)
										}
										telemetryService.captureToolUsage(this.taskId, block.name, false, true)
									}

									if (!didApprove) {
										await this.diffViewProvider.revertChanges()
										break
									}
								}

								const { newProblemsMessage, userEdits, autoFormattingEdits, finalContent } =
									await this.diffViewProvider.saveChanges()
								this.didEditFile = true // 用于确定在发送 API 请求之前是否应等待繁忙的终端更新
								if (userEdits) {
									await this.say(
										"user_feedback_diff",
										JSON.stringify({
											tool: fileExists ? "editedExistingFile" : "newFileCreated",
											path: getReadablePath(cwd, relPath),
											diff: userEdits,
										} satisfies ClineSayTool),
									)
									pushToolResult(
										`用户对您的内容进行了以下更新：\n\n${userEdits}\n\n` +
											(autoFormattingEdits
												? `用户的编辑器还对您的内容应用了以下自动格式化：\n\n${autoFormattingEdits}\n\n（注意：请密切关注诸如单引号转换为双引号、分号被删除或添加、长行被拆分为多行、调整缩进样式、添加/删除尾随逗号等更改。这将有助于确保将来对此文件的 SEARCH/REPLACE 操作准确无误。）\n\n`
												: "") +
											`包含您原始修改和附加编辑的更新内容已成功保存到 ${relPath.toPosix()}。以下是已保存文件的完整更新内容：\n\n` +
											`<final_file_content path="${relPath.toPosix()}">\n${finalContent}\n</final_file_content>\n\n` +
											`请注意：\n` +
											`1. 您无需使用这些更改重新编写文件，因为它们已被应用。\n` +
											`2. 使用此更新的文件内容作为新的基准继续执行任务。\n` +
											`3. 如果用户的编辑解决了部分任务或更改了需求，请相应地调整您的方法。\n` +
											`4. 重要提示：对于此文件的任何未来更改，请使用上面显示的 final_file_content 作为参考。此内容反映了文件的当前状态，包括用户编辑和任何自动格式化（例如，如果您使用了单引号但格式化程序将其转换为双引号）。始终基于此最终版本进行 SEARCH/REPLACE 操作以确保准确性。\n` +
											`${newProblemsMessage}`,
									)
								} else {
									pushToolResult(
										`内容已成功保存到 ${relPath.toPosix()}。\n\n` +
											(autoFormattingEdits
												? `除了您的编辑之外，用户的编辑器还对您的内容应用了以下自动格式化：\n\n${autoFormattingEdits}\n\n（注意：请密切关注诸如单引号转换为双引号、分号被删除或添加、长行被拆分为多行、调整缩进样式、添加/删除尾随逗号等更改。这将有助于确保将来对此文件的 SEARCH/REPLACE 操作准确无误。）\n\n`
												: "") +
											`以下是已保存文件的完整更新内容：\n\n` +
											`<final_file_content path="${relPath.toPosix()}">\n${finalContent}\n</final_file_content>\n\n` +
											`重要提示：对于此文件的任何未来更改，请使用上面显示的 final_file_content 作为参考。此内容反映了文件的当前状态，包括任何自动格式化（例如，如果您使用了单引号但格式化程序将其转换为双引号）。始终基于此最终版本进行 SEARCH/REPLACE 操作以确保准确性。\n\n` +
											`${newProblemsMessage}`,
									)
								}

								if (!fileExists) {
									this.providerRef.deref()?.workspaceTracker?.populateFilePaths()
								}

								await this.diffViewProvider.reset()

								await this.saveCheckpoint()

								break
							}
						} catch (error) {
							await handleError("写入文件", error)
							await this.diffViewProvider.revertChanges()
							await this.diffViewProvider.reset()

							break
						}
					}
					case "read_file": {
						const relPath: string | undefined = block.params.path
						const sharedMessageProps: ClineSayTool = {
							tool: "readFile",
							path: getReadablePath(cwd, removeClosingTag("path", relPath)),
						}
						try {
							if (block.partial) {
								const partialMessage = JSON.stringify({
									...sharedMessageProps,
									content: undefined,
								} satisfies ClineSayTool)
								if (this.shouldAutoApproveTool(block.name)) {
									this.removeLastPartialMessageIfExistsWithType("ask", "tool")
									await this.say("tool", partialMessage, undefined, block.partial)
								} else {
									this.removeLastPartialMessageIfExistsWithType("say", "tool")
									await this.ask("tool", partialMessage, block.partial).catch(() => {})
								}
								break
							} else {
								if (!relPath) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("read_file", "path"))

									break
								}

								const accessAllowed = this.clineIgnoreController.validateAccess(relPath)
								if (!accessAllowed) {
									await this.say("clineignore_error", relPath)
									pushToolResult(formatResponse.toolError(formatResponse.clineIgnoreError(relPath)))

									break
								}

								this.consecutiveMistakeCount = 0
								const absolutePath = path.resolve(cwd, relPath)
								const completeMessage = JSON.stringify({
									...sharedMessageProps,
									content: absolutePath,
								} satisfies ClineSayTool)
								if (this.shouldAutoApproveTool(block.name)) {
									this.removeLastPartialMessageIfExistsWithType("ask", "tool")
									await this.say("tool", completeMessage, undefined, false) // 需要发送 partialValue 布尔值，因为 undefined 有其自身的用途，即消息既不被视为部分消息，也不被视为部分消息的完成，而是作为单个完整的消息
									this.consecutiveAutoApprovedRequestsCount++
									telemetryService.captureToolUsage(this.taskId, block.name, true, true)
								} else {
									showNotificationForApprovalIfAutoApprovalEnabled(
										`Cline 想要读取 ${path.basename(absolutePath)}`,
									)
									this.removeLastPartialMessageIfExistsWithType("say", "tool")
									const didApprove = await askApproval("tool", completeMessage)
									if (!didApprove) {
										telemetryService.captureToolUsage(this.taskId, block.name, false, false)
										break
									}
									telemetryService.captureToolUsage(this.taskId, block.name, false, true)
								}
								// 现在正常执行工具
								const content = await extractTextFromFile(absolutePath)
								pushToolResult(content)

								break
							}
						} catch (error) {
							await handleError("读取文件", error)

							break
						}
					}
					case "list_files": {
						const relDirPath: string | undefined = block.params.path
						const recursiveRaw: string | undefined = block.params.recursive
						const recursive = recursiveRaw?.toLowerCase() === "true"
						const sharedMessageProps: ClineSayTool = {
							tool: !recursive ? "listFilesTopLevel" : "listFilesRecursive",
							path: getReadablePath(cwd, removeClosingTag("path", relDirPath)),
						}
						try {
							if (block.partial) {
								const partialMessage = JSON.stringify({
									...sharedMessageProps,
									content: "",
								} satisfies ClineSayTool)
								if (this.shouldAutoApproveTool(block.name)) {
									this.removeLastPartialMessageIfExistsWithType("ask", "tool")
									await this.say("tool", partialMessage, undefined, block.partial)
								} else {
									this.removeLastPartialMessageIfExistsWithType("say", "tool")
									await this.ask("tool", partialMessage, block.partial).catch(() => {})
								}
								break
							} else {
								if (!relDirPath) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("list_files", "path"))

									break
								}
								this.consecutiveMistakeCount = 0

								const absolutePath = path.resolve(cwd, relDirPath)

								const [files, didHitLimit] = await listFiles(absolutePath, recursive, 200)

								const result = formatResponse.formatFilesList(
									absolutePath,
									files,
									didHitLimit,
									this.clineIgnoreController,
								)
								const completeMessage = JSON.stringify({
									...sharedMessageProps,
									content: result,
								} satisfies ClineSayTool)
								if (this.shouldAutoApproveTool(block.name)) {
									this.removeLastPartialMessageIfExistsWithType("ask", "tool")
									await this.say("tool", completeMessage, undefined, false)
									this.consecutiveAutoApprovedRequestsCount++
									telemetryService.captureToolUsage(this.taskId, block.name, true, true)
								} else {
									showNotificationForApprovalIfAutoApprovalEnabled(
										`Cline 想要查看目录 ${path.basename(absolutePath)}/`,
									)
									this.removeLastPartialMessageIfExistsWithType("say", "tool")
									const didApprove = await askApproval("tool", completeMessage)
									if (!didApprove) {
										telemetryService.captureToolUsage(this.taskId, block.name, false, false)
										break
									}
									telemetryService.captureToolUsage(this.taskId, block.name, false, true)
								}
								pushToolResult(result)

								break
							}
						} catch (error) {
							await handleError("列出文件", error)

							break
						}
					}
					case "list_code_definition_names": {
						const relDirPath: string | undefined = block.params.path
						const sharedMessageProps: ClineSayTool = {
							tool: "listCodeDefinitionNames",
							path: getReadablePath(cwd, removeClosingTag("path", relDirPath)),
						}
						try {
							if (block.partial) {
								const partialMessage = JSON.stringify({
									...sharedMessageProps,
									content: "",
								} satisfies ClineSayTool)
								if (this.shouldAutoApproveTool(block.name)) {
									this.removeLastPartialMessageIfExistsWithType("ask", "tool")
									await this.say("tool", partialMessage, undefined, block.partial)
								} else {
									this.removeLastPartialMessageIfExistsWithType("say", "tool")
									await this.ask("tool", partialMessage, block.partial).catch(() => {})
								}
								break
							} else {
								if (!relDirPath) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("list_code_definition_names", "path"))

									break
								}

								this.consecutiveMistakeCount = 0

								const absolutePath = path.resolve(cwd, relDirPath)
								const result = await parseSourceCodeForDefinitionsTopLevel(
									absolutePath,
									this.clineIgnoreController,
								)

								const completeMessage = JSON.stringify({
									...sharedMessageProps,
									content: result,
								} satisfies ClineSayTool)
								if (this.shouldAutoApproveTool(block.name)) {
									this.removeLastPartialMessageIfExistsWithType("ask", "tool")
									await this.say("tool", completeMessage, undefined, false)
									this.consecutiveAutoApprovedRequestsCount++
									telemetryService.captureToolUsage(this.taskId, block.name, true, true)
								} else {
									showNotificationForApprovalIfAutoApprovalEnabled(
										`Cline 想要查看 ${path.basename(absolutePath)}/ 中的源代码定义`,
									)
									this.removeLastPartialMessageIfExistsWithType("say", "tool")
									const didApprove = await askApproval("tool", completeMessage)
									if (!didApprove) {
										telemetryService.captureToolUsage(this.taskId, block.name, false, false)
										break
									}
									telemetryService.captureToolUsage(this.taskId, block.name, false, true)
								}
								pushToolResult(result)

								break
							}
						} catch (error) {
							await handleError("解析源代码定义", error)

							break
						}
					}
					case "search_files": {
						const relDirPath: string | undefined = block.params.path
						const regex: string | undefined = block.params.regex
						const filePattern: string | undefined = block.params.file_pattern
						const sharedMessageProps: ClineSayTool = {
							tool: "searchFiles",
							path: getReadablePath(cwd, removeClosingTag("path", relDirPath)),
							regex: removeClosingTag("regex", regex),
							filePattern: removeClosingTag("file_pattern", filePattern),
						}
						try {
							if (block.partial) {
								const partialMessage = JSON.stringify({
									...sharedMessageProps,
									content: "",
								} satisfies ClineSayTool)
								if (this.shouldAutoApproveTool(block.name)) {
									this.removeLastPartialMessageIfExistsWithType("ask", "tool")
									await this.say("tool", partialMessage, undefined, block.partial)
								} else {
									this.removeLastPartialMessageIfExistsWithType("say", "tool")
									await this.ask("tool", partialMessage, block.partial).catch(() => {})
								}
								break
							} else {
								if (!relDirPath) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("search_files", "path"))

									break
								}
								if (!regex) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("search_files", "regex"))

									break
								}
								this.consecutiveMistakeCount = 0

								const absolutePath = path.resolve(cwd, relDirPath)
								const results = await regexSearchFiles(
									cwd,
									absolutePath,
									regex,
									filePattern,
									this.clineIgnoreController,
								)

								const completeMessage = JSON.stringify({
									...sharedMessageProps,
									content: results,
								} satisfies ClineSayTool)
								if (this.shouldAutoApproveTool(block.name)) {
									this.removeLastPartialMessageIfExistsWithType("ask", "tool")
									await this.say("tool", completeMessage, undefined, false)
									this.consecutiveAutoApprovedRequestsCount++
									telemetryService.captureToolUsage(this.taskId, block.name, true, true)
								} else {
									showNotificationForApprovalIfAutoApprovalEnabled(
										`Cline 想要在 ${path.basename(absolutePath)}/ 中搜索文件`,
									)
									this.removeLastPartialMessageIfExistsWithType("say", "tool")
									const didApprove = await askApproval("tool", completeMessage)
									if (!didApprove) {
										telemetryService.captureToolUsage(this.taskId, block.name, false, false)
										break
									}
									telemetryService.captureToolUsage(this.taskId, block.name, false, true)
								}
								pushToolResult(results)

								break
							}
						} catch (error) {
							await handleError("搜索文件", error)

							break
						}
					}
					case "browser_action": {
						const action: BrowserAction | undefined = block.params.action as BrowserAction
						const url: string | undefined = block.params.url
						const coordinate: string | undefined = block.params.coordinate
						const text: string | undefined = block.params.text
						if (!action || !browserActions.includes(action)) {
							// 检查 action 以确保其完整且有效
							if (!block.partial) {
								// 如果块已完成但我们没有有效的 action，则这是一个错误
								this.consecutiveMistakeCount++
								pushToolResult(await this.sayAndCreateMissingParamError("browser_action", "action"))
								await this.browserSession.closeBrowser()
							}
							break
						}

						try {
							if (block.partial) {
								if (action === "launch") {
									if (this.shouldAutoApproveTool(block.name)) {
										this.removeLastPartialMessageIfExistsWithType("ask", "browser_action_launch")
										await this.say(
											"browser_action_launch",
											removeClosingTag("url", url),
											undefined,
											block.partial,
										)
									} else {
										this.removeLastPartialMessageIfExistsWithType("say", "browser_action_launch")
										await this.ask(
											"browser_action_launch",
											removeClosingTag("url", url),
											block.partial,
										).catch(() => {})
									}
								} else {
									await this.say(
										"browser_action",
										JSON.stringify({
											action: action as BrowserAction,
											coordinate: removeClosingTag("coordinate", coordinate),
											text: removeClosingTag("text", text),
										} satisfies ClineSayBrowserAction),
										undefined,
										block.partial,
									)
								}
								break
							} else {
								let browserActionResult: BrowserActionResult
								if (action === "launch") {
									if (!url) {
										this.consecutiveMistakeCount++
										pushToolResult(await this.sayAndCreateMissingParamError("browser_action", "url"))
										await this.browserSession.closeBrowser()

										break
									}
									this.consecutiveMistakeCount = 0

									if (this.shouldAutoApproveTool(block.name)) {
										this.removeLastPartialMessageIfExistsWithType("ask", "browser_action_launch")
										await this.say("browser_action_launch", url, undefined, false)
										this.consecutiveAutoApprovedRequestsCount++
									} else {
										showNotificationForApprovalIfAutoApprovalEnabled(`Cline 想要使用浏览器并启动 ${url}`)
										this.removeLastPartialMessageIfExistsWithType("say", "browser_action_launch")
										const didApprove = await askApproval("browser_action_launch", url)
										if (!didApprove) {
											break
										}
									}

									// 注意：调用此消息是可以的，因为部分 inspect_site 已完成流式传输。我们唯一需要避免的情况是在消息数组末尾存在部分消息时发送消息。例如，api_req_finished 消息会干扰部分消息，因此我们需要删除它。
									// await this.say("inspect_site_result", "") // 没有结果，启动加载旋转器等待结果
									await this.say("browser_action_result", "") // 启动加载旋转器

									await this.browserSession.launchBrowser()
									browserActionResult = await this.browserSession.navigateToUrl(url)
								} else {
									if (action === "click") {
										if (!coordinate) {
											this.consecutiveMistakeCount++
											pushToolResult(
												await this.sayAndCreateMissingParamError("browser_action", "coordinate"),
											)
											await this.browserSession.closeBrowser()

											break // 不能在内部 switch 语句中
										}
									}
									if (action === "type") {
										if (!text) {
											this.consecutiveMistakeCount++
											pushToolResult(await this.sayAndCreateMissingParamError("browser_action", "text"))
											await this.browserSession.closeBrowser()

											break
										}
									}
									this.consecutiveMistakeCount = 0
									await this.say(
										"browser_action",
										JSON.stringify({
											action: action as BrowserAction,
											coordinate,
											text,
										} satisfies ClineSayBrowserAction),
										undefined,
										false,
									)
									switch (action) {
										case "click":
											browserActionResult = await this.browserSession.click(coordinate!)
											break
										case "type":
											browserActionResult = await this.browserSession.type(text!)
											break
										case "scroll_down":
											browserActionResult = await this.browserSession.scrollDown()
											break
										case "scroll_up":
											browserActionResult = await this.browserSession.scrollUp()
											break
										case "close":
											browserActionResult = await this.browserSession.closeBrowser()
											break
									}
								}

								switch (action) {
									case "launch":
									case "click":
									case "type":
									case "scroll_down":
									case "scroll_up":
										await this.say("browser_action_result", JSON.stringify(browserActionResult))
										pushToolResult(
											formatResponse.toolResult(
												`浏览器操作已执行。控制台日志和屏幕截图已被捕获供您分析。\n\n控制台日志：\n${
													browserActionResult.logs || "(无新日志)"
												}\n\n（请记住：如果您需要继续使用非 \`browser_action\` 工具或启动新浏览器，则必须先关闭此浏览器。例如，如果在分析日志和屏幕截图后需要编辑文件，则必须先关闭浏览器才能使用 write_to_file 工具。）`,
												browserActionResult.screenshot ? [browserActionResult.screenshot] : [],
											),
										)

										break
									case "close":
										pushToolResult(formatResponse.toolResult(`浏览器已关闭。您现在可以继续使用其他工具。`))

										break
								}

								break
							}
						} catch (error) {
							await this.browserSession.closeBrowser() // 如果发生任何错误，浏览器会话将终止
							await handleError("执行浏览器操作", error)

							break
						}
					}
					case "execute_command": {
						const command: string | undefined = block.params.command
						const requiresApprovalRaw: string | undefined = block.params.requires_approval
						const requiresApproval = requiresApprovalRaw?.toLowerCase() === "true"

						try {
							if (block.partial) {
								if (this.shouldAutoApproveTool(block.name)) {
									// 因为根据即将到来的参数 requiresApproval，这可能会变成一个 ask - 我们不能过早地部分流式传输 say。因此，在这种特殊情况下，我们必须等待 requiresApproval 参数完成后再呈现它。
									// await this.say(
									// 	"command",
									// 	removeClosingTag("command", command),
									// 	undefined,
									// 	block.partial,
									// ).catch(() => {})
								} else {
									// 不需要删除最后一个部分，因为我们无法流式传输 say
									await this.ask("command", removeClosingTag("command", command), block.partial).catch(() => {})
								}
								break
							} else {
								if (!command) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("execute_command", "command"))

									break
								}
								if (!requiresApprovalRaw) {
									this.consecutiveMistakeCount++
									pushToolResult(
										await this.sayAndCreateMissingParamError("execute_command", "requires_approval"),
									)

									break
								}
								this.consecutiveMistakeCount = 0

								const ignoredFileAttemptedToAccess = this.clineIgnoreController.validateCommand(command)
								if (ignoredFileAttemptedToAccess) {
									await this.say("clineignore_error", ignoredFileAttemptedToAccess)
									pushToolResult(
										formatResponse.toolError(formatResponse.clineIgnoreError(ignoredFileAttemptedToAccess)),
									)

									break
								}

								let didAutoApprove = false

								if (!requiresApproval && this.shouldAutoApproveTool(block.name)) {
									this.removeLastPartialMessageIfExistsWithType("ask", "command")
									await this.say("command", command, undefined, false)
									this.consecutiveAutoApprovedRequestsCount++
									didAutoApprove = true
								} else {
									showNotificationForApprovalIfAutoApprovalEnabled(`Cline 想要执行命令： ${command}`)
									// this.removeLastPartialMessageIfExistsWithType("say", "command")
									const didApprove = await askApproval(
										"command",
										command +
											`${this.shouldAutoApproveTool(block.name) && requiresApproval ? COMMAND_REQ_APP_STRING : ""}`, // 丑陋的 hack，直到我们重构 combineCommandSequences
									)
									if (!didApprove) {
										break
									}
								}

								let timeoutId: NodeJS.Timeout | undefined
								if (didAutoApprove && this.autoApprovalSettings.enableNotifications) {
									// 如果命令被自动批准，并且运行时间很长，我们需要在一段时间没有进展后通知用户
									timeoutId = setTimeout(() => {
										showSystemNotification({
											subtitle: "命令仍在运行",
											message: "一个自动批准的命令已运行 30 秒，可能需要您的注意。",
										})
									}, 30_000)
								}

								const [userRejected, result] = await this.executeCommandTool(command)
								if (timeoutId) {
									clearTimeout(timeoutId)
								}
								if (userRejected) {
									this.didRejectTool = true
								}

								// 如果命令修改了工作区，则重新填充文件路径（除非用户手动创建/删除文件，否则 vscode 侦听器不会触发）
								this.providerRef.deref()?.workspaceTracker?.populateFilePaths()

								pushToolResult(result)

								await this.saveCheckpoint()

								break
							}
						} catch (error) {
							await handleError("执行命令", error)

							break
						}
					}
					case "use_mcp_tool": {
						const server_name: string | undefined = block.params.server_name
						const tool_name: string | undefined = block.params.tool_name
						const mcp_arguments: string | undefined = block.params.arguments
						try {
							if (block.partial) {
								const partialMessage = JSON.stringify({
									type: "use_mcp_tool",
									serverName: removeClosingTag("server_name", server_name),
									toolName: removeClosingTag("tool_name", tool_name),
									arguments: removeClosingTag("arguments", mcp_arguments),
								} satisfies ClineAskUseMcpServer)

								if (this.shouldAutoApproveTool(block.name)) {
									this.removeLastPartialMessageIfExistsWithType("ask", "use_mcp_server")
									await this.say("use_mcp_server", partialMessage, undefined, block.partial)
								} else {
									this.removeLastPartialMessageIfExistsWithType("say", "use_mcp_server")
									await this.ask("use_mcp_server", partialMessage, block.partial).catch(() => {})
								}

								break
							} else {
								if (!server_name) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("use_mcp_tool", "server_name"))

									break
								}
								if (!tool_name) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("use_mcp_tool", "tool_name"))

									break
								}
								// 参数是可选的，但如果提供，则必须是有效的 JSON
								// if (!mcp_arguments) {
								// 	this.consecutiveMistakeCount++
								// 	pushToolResult(await this.sayAndCreateMissingParamError("use_mcp_tool", "arguments"))
								// 	break
								// }
								let parsedArguments: Record<string, unknown> | undefined
								if (mcp_arguments) {
									try {
										parsedArguments = JSON.parse(mcp_arguments)
									} catch (error) {
										this.consecutiveMistakeCount++
										await this.say("error", `Cline 尝试使用 ${tool_name}，但 JSON 参数无效。正在重试...`)
										pushToolResult(
											formatResponse.toolError(
												formatResponse.invalidMcpToolArgumentError(server_name, tool_name),
											),
										)

										break
									}
								}
								this.consecutiveMistakeCount = 0
								const completeMessage = JSON.stringify({
									type: "use_mcp_tool",
									serverName: server_name,
									toolName: tool_name,
									arguments: mcp_arguments,
								} satisfies ClineAskUseMcpServer)

								const isToolAutoApproved = this.providerRef
									.deref()
									?.mcpHub?.connections?.find((conn) => conn.server.name === server_name)
									?.server.tools?.find((tool) => tool.name === tool_name)?.autoApprove

								if (this.shouldAutoApproveTool(block.name) && isToolAutoApproved) {
									this.removeLastPartialMessageIfExistsWithType("ask", "use_mcp_server")
									await this.say("use_mcp_server", completeMessage, undefined, false)
									this.consecutiveAutoApprovedRequestsCount++
								} else {
									showNotificationForApprovalIfAutoApprovalEnabled(
										`Cline 想要在 ${server_name} 上使用 ${tool_name}`,
									)
									this.removeLastPartialMessageIfExistsWithType("say", "use_mcp_server")
									const didApprove = await askApproval("use_mcp_server", completeMessage)
									if (!didApprove) {
										break
									}
								}

								// 现在执行工具
								await this.say("mcp_server_request_started") // 与 browser_action_result 相同
								const toolResult = await this.providerRef
									.deref()
									?.mcpHub?.callTool(server_name, tool_name, parsedArguments)

								// TODO: 添加进度指示器和解析图像及非文本响应的能力
								const toolResultPretty =
									(toolResult?.isError ? "错误：\n" : "") +
										toolResult?.content
											.map((item) => {
												if (item.type === "text") {
													return item.text
												}
												if (item.type === "resource") {
													const { blob, ...rest } = item.resource
													return JSON.stringify(rest, null, 2)
												}
												return ""
											})
											.filter(Boolean)
											.join("\n\n") || "（无响应）"
								await this.say("mcp_server_response", toolResultPretty)
								pushToolResult(formatResponse.toolResult(toolResultPretty))

								await this.saveCheckpoint()

								break
							}
						} catch (error) {
							await handleError("执行 MCP 工具", error)

							break
						}
					}
					case "access_mcp_resource": {
						const server_name: string | undefined = block.params.server_name
						const uri: string | undefined = block.params.uri
						try {
							if (block.partial) {
								const partialMessage = JSON.stringify({
									type: "access_mcp_resource",
									serverName: removeClosingTag("server_name", server_name),
									uri: removeClosingTag("uri", uri),
								} satisfies ClineAskUseMcpServer)

								if (this.shouldAutoApproveTool(block.name)) {
									this.removeLastPartialMessageIfExistsWithType("ask", "use_mcp_server")
									await this.say("use_mcp_server", partialMessage, undefined, block.partial)
								} else {
									this.removeLastPartialMessageIfExistsWithType("say", "use_mcp_server")
									await this.ask("use_mcp_server", partialMessage, block.partial).catch(() => {})
								}

								break
							} else {
								if (!server_name) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("access_mcp_resource", "server_name"))

									break
								}
								if (!uri) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("access_mcp_resource", "uri"))

									break
								}
								this.consecutiveMistakeCount = 0
								const completeMessage = JSON.stringify({
									type: "access_mcp_resource",
									serverName: server_name,
									uri,
								} satisfies ClineAskUseMcpServer)

								if (this.shouldAutoApproveTool(block.name)) {
									this.removeLastPartialMessageIfExistsWithType("ask", "use_mcp_server")
									await this.say("use_mcp_server", completeMessage, undefined, false)
									this.consecutiveAutoApprovedRequestsCount++
								} else {
									showNotificationForApprovalIfAutoApprovalEnabled(`Cline 想要访问 ${server_name} 上的 ${uri}`)
									this.removeLastPartialMessageIfExistsWithType("say", "use_mcp_server")
									const didApprove = await askApproval("use_mcp_server", completeMessage)
									if (!didApprove) {
										break
									}
								}

								// 现在执行工具
								await this.say("mcp_server_request_started")
								const resourceResult = await this.providerRef.deref()?.mcpHub?.readResource(server_name, uri)
								const resourceResultPretty =
									resourceResult?.contents
										.map((item) => {
											if (item.text) {
												return item.text
											}
											return ""
										})
										.filter(Boolean)
										.join("\n\n") || "（空响应）"
								await this.say("mcp_server_response", resourceResultPretty)
								pushToolResult(formatResponse.toolResult(resourceResultPretty))

								break
							}
						} catch (error) {
							await handleError("访问 MCP 资源", error)

							break
						}
					}
					case "ask_followup_question": {
						const question: string | undefined = block.params.question
						const optionsRaw: string | undefined = block.params.options
						const sharedMessage = {
							question: removeClosingTag("question", question),
							options: parsePartialArrayString(removeClosingTag("options", optionsRaw)),
						} satisfies ClineAskQuestion
						try {
							if (block.partial) {
								await this.ask("followup", JSON.stringify(sharedMessage), block.partial).catch(() => {})
								break
							} else {
								if (!question) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("ask_followup_question", "question"))

									break
								}
								this.consecutiveMistakeCount = 0

								if (this.autoApprovalSettings.enabled && this.autoApprovalSettings.enableNotifications) {
									showSystemNotification({
										subtitle: "Cline 有一个问题...",
										message: question.replace(/\n/g, " "),
									})
								}

								const { text, images } = await this.ask("followup", JSON.stringify(sharedMessage), false)

								// 检查选项是否包含文本响应
								if (optionsRaw && text && parsePartialArrayString(optionsRaw).includes(text)) {
									// 选择了有效选项，不在 UI 中显示用户消息
									// 使用选定的选项更新最后一条跟进消息
									const lastFollowupMessage = findLast(this.clineMessages, (m) => m.ask === "followup")
									if (lastFollowupMessage) {
										lastFollowupMessage.text = JSON.stringify({
											...sharedMessage,
											selected: text,
										} satisfies ClineAskQuestion)
										await this.saveClineMessages()
									}
								} else {
									// 未选择选项，发送用户反馈
									await this.say("user_feedback", text ?? "", images)
								}

								pushToolResult(formatResponse.toolResult(`<答案>\n${text}\n</答案>`, images))

								break
							}
						} catch (error) {
							await handleError("提问", error)

							break
						}
					}
					case "plan_mode_respond": {
						const response: string | undefined = block.params.response
						const optionsRaw: string | undefined = block.params.options
						const sharedMessage = {
							response: removeClosingTag("response", response),
							options: parsePartialArrayString(removeClosingTag("options", optionsRaw)),
						} satisfies ClinePlanModeResponse
						try {
							if (block.partial) {
								await this.ask("plan_mode_respond", JSON.stringify(sharedMessage), block.partial).catch(() => {})
								break
							} else {
								if (!response) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("plan_mode_respond", "response"))
									//
									break
								}
								this.consecutiveMistakeCount = 0

								// 如果 (this.autoApprovalSettings.enabled && this.autoApprovalSettings.enableNotifications) {
								// 	showSystemNotification({
								// 		subtitle: "Cline 有一个响应...",
								// 		message: response.replace(/\n/g, " "),
								// 	})
								// }

								this.isAwaitingPlanResponse = true
								let { text, images } = await this.ask("plan_mode_respond", JSON.stringify(sharedMessage), false)
								this.isAwaitingPlanResponse = false

								// webview 调用 sendMessage 将发送此标记，以便将 webview 置于适当的状态（响应 ask），并作为用户切换到 ACT 模式的标志通知扩展。
								if (text === "PLAN_MODE_TOGGLE_RESPONSE") {
									text = ""
								}

								// 检查选项是否包含文本响应
								if (optionsRaw && text && parsePartialArrayString(optionsRaw).includes(text)) {
									// 选择了有效选项，不在 UI 中显示用户消息
									// 使用选定的选项更新最后一条计划消息
									const lastPlanMessage = findLast(this.clineMessages, (m) => m.ask === "plan_mode_respond")
									if (lastPlanMessage) {
										lastPlanMessage.text = JSON.stringify({
											...sharedMessage,
											selected: text,
										} satisfies ClinePlanModeResponse)
										await this.saveClineMessages()
									}
								} else {
									// 未选择选项，发送用户反馈
									if (text || images?.length) {
										await this.say("user_feedback", text ?? "", images)
									}
								}

								if (this.didRespondToPlanAskBySwitchingMode) {
									pushToolResult(
										formatResponse.toolResult(
											`[用户已切换到 ACT 模式，您现在可以继续执行任务。]` +
												(text
													? `\n\n用户在切换到 ACT 模式时还提供了以下消息：\n<user_message>\n${text}\n</user_message>`
													: ""),
											images,
										),
									)
								} else {
									// 如果我们没有切换到 ACT 模式，那么我们可以只发送 user_feedback 消息
									pushToolResult(formatResponse.toolResult(`<user_message>\n${text}\n</user_message>`, images))
								}

								//
								break
							}
						} catch (error) {
							await handleError("响应查询", error)
							//
							break
						}
					}
					case "attempt_completion": {
						/*
						this.consecutiveMistakeCount = 0
						let resultToSend = result
						if (command) {
							await this.say("completion_result", resultToSend)
							// TODO: 目前我们不处理此命令失败的情况，让 cline 知道并重试可能很有用
							const [didUserReject, commandResult] = await this.executeCommand(command, true)
							// 如果我们收到非空字符串，则命令被拒绝或失败
							if (commandResult) {
								return [didUserReject, commandResult]
							}
							resultToSend = ""
						}
						const { response, text, images } = await this.ask("completion_result", resultToSend) // 这会提示 webview 显示“新任务”按钮，并启用文本输入（此处为“text”）
						if (response === "yesButtonClicked") {
							return [false, ""] // 向递归循环发出停止信号（目前这永远不会发生，因为 yesButtonClicked 将触发新任务）
						}
						await this.say("user_feedback", text ?? "", images)
						return [
						*/
						const result: string | undefined = block.params.result
						const command: string | undefined = block.params.command

						const addNewChangesFlagToLastCompletionResultMessage = async () => {
							// 如果工作区有新更改，则添加 newchanges 标志

							const hasNewChanges = await this.doesLatestTaskCompletionHaveNewChanges()
							const lastCompletionResultMessage = findLast(this.clineMessages, (m) => m.say === "completion_result")
							if (
								lastCompletionResultMessage &&
								hasNewChanges &&
								!lastCompletionResultMessage.text?.endsWith(COMPLETION_RESULT_CHANGES_FLAG)
							) {
								lastCompletionResultMessage.text += COMPLETION_RESULT_CHANGES_FLAG
							}
							await this.saveClineMessages()
						}

						try {
							const lastMessage = this.clineMessages.at(-1)
							if (block.partial) {
								if (command) {
									// attempt_completion 文本已完成，现在我们正在获取命令
									// 删除之前的 partial attempt_completion ask，替换为 say，将状态发布到 webview，然后流式传输命令

									// const secondLastMessage = this.clineMessages.at(-2)
									// 注意：我们不希望自动批准作为 attempt_completion 工具一部分运行的命令
									if (lastMessage && lastMessage.ask === "command") {
										// 更新命令
										await this.ask("command", removeClosingTag("command", command), block.partial).catch(
											() => {},
										)
									} else {
										// 最后一条消息是 completion_result
										// 我们有命令字符串，这意味着我们也有结果，所以完成它（不必已经存在）
										await this.say("completion_result", removeClosingTag("result", result), undefined, false)
										await this.saveCheckpoint(true)
										await addNewChangesFlagToLastCompletionResultMessage()
										await this.ask("command", removeClosingTag("command", command), block.partial).catch(
											() => {},
										)
									}
								} else {
									// 没有命令，仍在输出部分结果
									await this.say(
										"completion_result",
										removeClosingTag("result", result),
										undefined,
										block.partial,
									)
								}
								break
							} else {
								if (!result) {
									this.consecutiveMistakeCount++
									pushToolResult(await this.sayAndCreateMissingParamError("attempt_completion", "result"))
									break
								}
								this.consecutiveMistakeCount = 0

								if (this.autoApprovalSettings.enabled && this.autoApprovalSettings.enableNotifications) {
									showSystemNotification({
										subtitle: "任务已完成",
										message: result.replace(/\n/g, " "),
									})
								}

								let commandResult: ToolResponse | undefined
								if (command) {
									if (lastMessage && lastMessage.ask !== "command") {
										// 尚未发送命令消息，因此首先发送 completion_result 然后发送命令
										await this.say("completion_result", result, undefined, false)
										await this.saveCheckpoint(true)
										await addNewChangesFlagToLastCompletionResultMessage()
										telemetryService.captureTaskCompleted(this.taskId)
									} else {
										// 我们已经发送了命令消息，这意味着完整的完成消息也已发送
										await this.saveCheckpoint(true)
									}

									// 完成命令消息
									const didApprove = await askApproval("command", command)
									if (!didApprove) {
										break
									}
									const [userRejected, execCommandResult] = await this.executeCommandTool(command!)
									if (userRejected) {
										this.didRejectTool = true
										pushToolResult(execCommandResult)
										break
									}
									// 用户没有拒绝，但命令可能有输出
									commandResult = execCommandResult
								} else {
									await this.say("completion_result", result, undefined, false)
									await this.saveCheckpoint(true)
									await addNewChangesFlagToLastCompletionResultMessage()
									telemetryService.captureTaskCompleted(this.taskId)
								}

								// 我们已经发送了 completion_result says，空字符串 asks 会放弃对按钮和字段的控制
								const { response, text, images } = await this.ask("completion_result", "", false)
								if (response === "yesButtonClicked") {
									pushToolResult("") // 向递归循环发出停止信号（目前这永远不会发生，因为 yesButtonClicked 将触发新任务）
									break
								}
								await this.say("user_feedback", text ?? "", images)

								const toolResults: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = []
								if (commandResult) {
									if (typeof commandResult === "string") {
										toolResults.push({
											type: "text",
											text: commandResult,
										})
									} else if (Array.isArray(commandResult)) {
										toolResults.push(...commandResult)
									}
								}
								toolResults.push({
									type: "text",
									text: `用户已对结果提供反馈。请考虑他们的输入以继续任务，然后再次尝试完成。\n<feedback>\n${text}\n</feedback>`,
								})
								toolResults.push(...formatResponse.imageBlocks(images))
								this.userMessageContent.push({
									type: "text",
									text: `${toolDescription()} 结果：`,
								})
								this.userMessageContent.push(...toolResults)

								//
								break
							}
						} catch (error) {
							await handleError("尝试完成", error)

							break
						}
					}
				}
				break
		}

		/*
		看到超出边界是正常的，这意味着下一个工具调用正在构建并准备添加到 assistantMessageContent 中以进行展示。
		当你看到 UI 在此期间处于非活动状态时，意味着工具在没有显示任何 UI 的情况下中断。例如，当 relpath 未定义时，write_to_file 工具会中断，对于无效的 relpath，它永远不会显示 UI。
		*/
		this.presentAssistantMessageLocked = false // 需要放在这里，否则下面调用 this.presentAssistantMessage 时会（有时）失败，因为它被锁定了
		// 注意：当工具被拒绝时，迭代器流会中断，并等待 userMessageContentReady 为 true。未来对 present 的调用会因为 didRejectTool 而跳过执行，并迭代直到 contentIndex 设置为消息长度，然后它自己将 userMessageContentReady 设置为 true（而不是在迭代器中提前这样做）
		if (!block.partial || this.didRejectTool || this.didAlreadyUseTool) {
			// 块已完成流式传输和执行
			if (this.currentStreamingContentIndex === this.assistantMessageContent.length - 1) {
				// 即使在 !didCompleteReadingStream 的情况下递增也没关系，如果超出边界它会返回，随着流继续，如果新块准备好了，它会调用 presentAssistantMessage。如果流已完成，则在超出边界时将 userMessageContentReady 设置为 true。这优雅地允许流继续并呈现所有潜在的内容块。
				// 最后一个块已完成，并且已完成执行
				this.userMessageContentReady = true // 将允许 pwaitfor 继续
			}

			// 如果存在下一个块则调用它（如果不存在，则当读取流准备好时会调用它）
			this.currentStreamingContentIndex++ // 无论如何都需要递增，这样当读取流再次调用此函数时，它将流式传输下一个块

			if (this.currentStreamingContentIndex < this.assistantMessageContent.length) {
				// 已经有更多内容块要流式传输，所以我们将自己调用这个函数
				// await this.presentAssistantContent()

				this.presentAssistantMessage()
				return
			}
		}
		// 块是部分的，但读取流可能已经完成
		if (this.presentAssistantMessageHasPendingUpdates) {
			this.presentAssistantMessage()
		}
	}

	async recursivelyMakeClineRequests(
		userContent: UserContent,
		includeFileDetails: boolean = false,
		isNewTask: boolean = false,
	): Promise<boolean> {
		if (this.abort) {
			throw new Error("Cline 实例已中止")
		}

		if (this.consecutiveMistakeCount >= 3) {
			if (this.autoApprovalSettings.enabled && this.autoApprovalSettings.enableNotifications) {
				showSystemNotification({
					subtitle: "错误",
					message: "Cline 遇到问题。您想继续任务吗？",
				})
			}
			const { response, text, images } = await this.ask(
				"mistake_limit_reached",
				this.api.getModel().id.includes("claude")
					? `这可能表明其思维过程出现故障或无法正确使用工具，可以通过用户指导来缓解（例如"尝试将任务分解为更小的步骤"）。`
					: "Cline 使用复杂的提示和迭代任务执行，这对能力较弱的模型可能具有挑战性。为获得最佳结果，建议使用 Claude 3.7 Sonnet，它具有先进的代理编码能力。",
			)
			if (response === "messageResponse") {
				userContent.push(
					...[
						{
							type: "text",
							text: formatResponse.tooManyMistakes(text),
						} as Anthropic.Messages.TextBlockParam,
						...formatResponse.imageBlocks(images),
					],
				)
			}
			this.consecutiveMistakeCount = 0
		}

		if (
			this.autoApprovalSettings.enabled &&
			this.consecutiveAutoApprovedRequestsCount >= this.autoApprovalSettings.maxRequests
		) {
			if (this.autoApprovalSettings.enableNotifications) {
				showSystemNotification({
					subtitle: "已达到最大请求数",
					message: `Cline 已自动批准 ${this.autoApprovalSettings.maxRequests.toString()} 个 API 请求。`,
				})
			}
			await this.ask(
				"auto_approval_max_req_reached",
				`Cline 已自动批准 ${this.autoApprovalSettings.maxRequests.toString()} 个 API 请求。您想重置计数并继续任务吗？`,
			)
			// 如果我们通过了这个 promise，意味着用户批准了并且没有开始新任务
			this.consecutiveAutoApprovedRequestsCount = 0
		}

		// 获取前一个 api 请求的索引，以检查令牌使用情况并确定是否需要截断对话历史
		const previousApiReqIndex = findLastIndex(this.clineMessages, (m) => m.say === "api_req_started")

		// 如果这是第一个 API 请求，则保存检查点
		const isFirstRequest = this.clineMessages.filter((m) => m.say === "api_req_started").length === 0
		if (isFirstRequest) {
			await this.say("checkpoint_created") // 没有哈希，因为我们需要等待 CheckpointTracker 初始化
		}

		// 获取详细信息是一个昂贵的操作，它使用 globby 自上而下构建项目的文件结构，对于大型项目可能需要几秒钟
		// 为了最佳用户体验，我们在此过程中显示带有加载旋转器的占位符 api_req_started 消息
		await this.say(
			"api_req_started",
			JSON.stringify({
				request: userContent.map((block) => formatContentBlockToMarkdown(block)).join("\n\n") + "\n\n加载中...",
			}),
		)

		// 利用这个机会初始化检查点跟踪器（在构造函数中初始化可能很昂贵）
		// 修复：目前我们允许用户为旧任务初始化检查点，但如果在错误的工作区中打开任务，这可能会有问题
		// isNewTask &&
		if (!this.checkpointTracker && !this.checkpointTrackerErrorMessage) {
			try {
				this.checkpointTracker = await pTimeout(
					CheckpointTracker.create(this.taskId, this.providerRef.deref()?.context.globalStorageUri.fsPath),
					{
						milliseconds: 15_000,
						message: "检查点初始化时间过长。考虑在使用 git 的项目中重新打开 Cline，或禁用检查点。",
					},
				)
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : "未知错误"
				console.error("无法初始化检查点跟踪器:", errorMessage)
				this.checkpointTrackerErrorMessage = errorMessage // 将立即显示，因为我们接下来保存 saveClineMessages，它会将状态发布到 webview
			}
		}

		// 现在检查点跟踪器已初始化，使用提交哈希更新虚拟 checkpoint_created 消息。（这是必要的，因为我们使用 API 请求加载作为初始化检查点跟踪器的机会，这可能需要一些时间）
		if (isFirstRequest) {
			const commitHash = await this.checkpointTracker?.commit()
			const lastCheckpointMessage = findLast(this.clineMessages, (m) => m.say === "checkpoint_created")
			if (lastCheckpointMessage) {
				lastCheckpointMessage.lastCheckpointHash = commitHash
				await this.saveClineMessages()
			}
		}

		const [parsedUserContent, environmentDetails] = await this.loadContext(userContent, includeFileDetails)
		userContent = parsedUserContent
		// 将环境详细信息作为单独的文本块添加，与工具结果分开
		userContent.push({ type: "text", text: environmentDetails })

		await this.addToApiConversationHistory({
			role: "user",
			content: userContent,
		})

		telemetryService.captureConversationTurnEvent(this.taskId, this.apiProvider, this.api.getModel().id, "user")

		// 由于我们发送了一个占位符 api_req_started 消息来更新 webview，同时等待实际开始 API 请求（例如加载潜在的详细信息），我们需要更新该消息的文本
		const lastApiReqIndex = findLastIndex(this.clineMessages, (m) => m.say === "api_req_started")
		this.clineMessages[lastApiReqIndex].text = JSON.stringify({
			request: userContent.map((block) => formatContentBlockToMarkdown(block)).join("\n\n"),
		} satisfies ClineApiReqInfo)
		await this.saveClineMessages()
		await this.providerRef.deref()?.postStateToWebview()

		try {
			let cacheWriteTokens = 0
			let cacheReadTokens = 0
			let inputTokens = 0
			let outputTokens = 0
			let totalCost: number | undefined

			// 更新 api_req_started。我们不能再使用 api_req_finished，因为它是一个独特的情况，可能在流式消息之后出现（即在更新或执行的中间）
			// 幸运的是，api_req_finished 总是为 GUI 解析出来的，所以它仅用于遗留目的，以跟踪历史任务中的价格
			// （几个月后值得删除）
			const updateApiReqMsg = (cancelReason?: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
				this.clineMessages[lastApiReqIndex].text = JSON.stringify({
					...JSON.parse(this.clineMessages[lastApiReqIndex].text || "{}"),
					tokensIn: inputTokens,
					tokensOut: outputTokens,
					cacheWrites: cacheWriteTokens,
					cacheReads: cacheReadTokens,
					cost:
						totalCost ??
						calculateApiCostAnthropic(
							this.api.getModel().info,
							inputTokens,
							outputTokens,
							cacheWriteTokens,
							cacheReadTokens,
						),
					cancelReason,
					streamingFailedMessage,
				} satisfies ClineApiReqInfo)
			}

			const abortStream = async (cancelReason: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
				if (this.diffViewProvider.isEditing) {
					await this.diffViewProvider.revertChanges() // 关闭差异视图
				}

				// 如果最后一条消息是部分的，我们需要更新并保存它
				const lastMessage = this.clineMessages.at(-1)
				if (lastMessage && lastMessage.partial) {
					// lastMessage.ts = Date.now() 不要更新 ts，因为它用作 virtuoso 列表的键
					lastMessage.partial = false
					// 不是流式传输 partialMessage 事件，我们像正常一样进行保存和发布以持久化到磁盘
					console.log("更新部分消息", lastMessage)
					// await this.saveClineMessages()
				}

				// 让助手知道他们的响应被中断，以便在任务恢复时使用
				await this.addToApiConversationHistory({
					role: "assistant",
					content: [
						{
							type: "text",
							text:
								assistantMessage +
								`\n\n[${cancelReason === "streaming_failed" ? "响应被 API 错误中断" : "响应被用户中断"}]`,
						},
					],
				})

				// 更新 api_req_started 以显示取消和成本，以便我们可以显示部分流的成本
				updateApiReqMsg(cancelReason, streamingFailedMessage)
				await this.saveClineMessages()

				telemetryService.captureConversationTurnEvent(this.taskId, this.apiProvider, this.api.getModel().id, "assistant")

				// 向提供者发出信号，表明它可以从磁盘检索保存的消息，因为 abortTask 本质上不能被等待
				this.didFinishAbortingStream = true
			}

			// 重置流式状态
			this.currentStreamingContentIndex = 0
			this.assistantMessageContent = []
			this.didCompleteReadingStream = false
			this.userMessageContent = []
			this.userMessageContentReady = false
			this.didRejectTool = false
			this.didAlreadyUseTool = false
			this.presentAssistantMessageLocked = false
			this.presentAssistantMessageHasPendingUpdates = false
			this.didAutomaticallyRetryFailedApiRequest = false
			await this.diffViewProvider.reset()

			const stream = this.attemptApiRequest(previousApiReqIndex) // 仅在第一个块成功时产生，否则将允许用户重试请求（最可能是由于速率限制错误，这会在第一个块上抛出）
			let assistantMessage = ""
			let reasoningMessage = ""
			this.isStreaming = true
			let didReceiveUsageChunk = false
			try {
				for await (const chunk of stream) {
					if (!chunk) {
						continue
					}
					switch (chunk.type) {
						case "usage":
							didReceiveUsageChunk = true
							inputTokens += chunk.inputTokens
							outputTokens += chunk.outputTokens
							cacheWriteTokens += chunk.cacheWriteTokens ?? 0
							cacheReadTokens += chunk.cacheReadTokens ?? 0
							totalCost = chunk.totalCost
							break
						case "reasoning":
							// 推理总是在助手消息之前出现
							reasoningMessage += chunk.reasoning
							await this.say("reasoning", reasoningMessage, undefined, true)
							break
						case "text":
							if (reasoningMessage && assistantMessage.length === 0) {
								// 完成推理消息
								await this.say("reasoning", reasoningMessage, undefined, false)
							}
							assistantMessage += chunk.text
							// 将原始助手消息解析为内容块
							const prevLength = this.assistantMessageContent.length
							this.assistantMessageContent = parseAssistantMessage(assistantMessage)
							if (this.assistantMessageContent.length > prevLength) {
								this.userMessageContentReady = false // 有新内容需要呈现，重置为 false，以防之前的内容将其设置为 true
							}
							// 向用户呈现内容
							this.presentAssistantMessage()
							break
					}

					if (this.abort) {
						console.log("中止流...")
						if (!this.abandoned) {
							// 只有当这个实例没有被放弃时才需要优雅地中止（有时 openrouter 流会挂起，在这种情况下，这会影响 cline 的未来实例）
							await abortStream("user_cancelled")
						}
						break // 中止流
					}

					if (this.didRejectTool) {
						// userContent 有工具拒绝，所以中断助手的响应以呈现用户的反馈
						assistantMessage += "\n\n[响应被用户反馈中断]"
						// this.userMessageContentReady = true // 不是提前设置这个，而是允许呈现迭代器完成并在准备好时设置 userMessageContentReady
						break
					}

					// 之前：我们需要让请求完成，以便 openrouter 获取生成详细信息
					// 更新：中断请求提供更好的用户体验，代价是无法检索 API 成本
					if (this.didAlreadyUseTool) {
						assistantMessage += "\n\n[响应被工具使用结果中断。一次只能使用一个工具，并且应该放在消息的末尾。]"
						break
					}
				}
			} catch (error) {
				// 当扩展不再等待 cline 实例完成中止时，会发生放弃（当 for 循环中的任何函数由于 this.abort 而抛出错误时，这里会抛出错误）
				if (!this.abandoned) {
					this.abortTask() // 如果流失败，任务可能处于各种状态（即可能已经流式传输了一些用户可能已执行的工具），所以我们只能复制取消任务
					const errorMessage = this.formatErrorWithStatusCode(error)

					await abortStream("streaming_failed", errorMessage)
					const history = await this.providerRef.deref()?.getTaskWithId(this.taskId)
					if (history) {
						await this.providerRef.deref()?.initClineWithHistoryItem(history.historyItem)
						// await this.providerRef.deref()?.postStateToWebview()
					}
				}
			} finally {
				this.isStreaming = false
			}

			// OpenRouter/Cline 可能不会将令牌使用情况作为流的一部分返回（因为它可能提前中止），所以我们在流完成后获取
			// （下面的 updateApiReq 将使用使用详细信息更新 api_req_started 消息。我们异步执行此操作，以便它在后台更新 api_req_started 消息）
			if (!didReceiveUsageChunk) {
				this.api.getApiStreamUsage?.().then(async (apiStreamUsage) => {
					if (apiStreamUsage) {
						inputTokens += apiStreamUsage.inputTokens
						outputTokens += apiStreamUsage.outputTokens
						cacheWriteTokens += apiStreamUsage.cacheWriteTokens ?? 0
						cacheReadTokens += apiStreamUsage.cacheReadTokens ?? 0
						totalCost = apiStreamUsage.totalCost
					}
					updateApiReqMsg()
					await this.saveClineMessages()
					await this.providerRef.deref()?.postStateToWebview()
				})
			}

			// 需要在这里调用，以防流被中止
			if (this.abort) {
				throw new Error("Cline 实例已中止")
			}

			this.didCompleteReadingStream = true

			// 将任何块设置为完成，以允许 presentAssistantMessage 完成并将 userMessageContentReady 设置为 true
			// （可能是没有后续工具使用的文本块，或者最后的文本块，或者无效的工具使用等。无论如何，presentAssistantMessage 依赖于这些块要么完成，要么用户拒绝一个块，以便继续并最终将 userMessageContentReady 设置为 true）
			const partialBlocks = this.assistantMessageContent.filter((block) => block.partial)
			partialBlocks.forEach((block) => {
				block.partial = false
			})
			// this.assistantMessageContent.forEach((e) => (e.partial = false)) // 不能这样做，因为工具可能正在执行中
			if (partialBlocks.length > 0) {
				this.presentAssistantMessage() // 如果有内容要更新，它将完成并将 this.userMessageContentReady 更新为 true，我们在进行下一个请求之前会等待这个。这实际上只是呈现我们刚刚设置为完成的最后一个部分消息
			}

			updateApiReqMsg()
			await this.saveClineMessages()
			await this.providerRef.deref()?.postStateToWebview()

			// 现在添加到 apiconversationhistory
			// 需要在继续使用工具之前将助手响应保存到文件，因为用户可以随时退出，我们将无法保存助手的响应
			let didEndLoop = false
			if (assistantMessage.length > 0) {
				telemetryService.captureConversationTurnEvent(this.taskId, this.apiProvider, this.api.getModel().id, "assistant")

				await this.addToApiConversationHistory({
					role: "assistant",
					content: [{ type: "text", text: assistantMessage }],
				})

				// 注意：此注释供将来参考 - 这是 userMessageContent 未设置为 true 的解决方法。这是因为它在 didRejectTool 时不会递归调用部分块，所以它会卡在等待部分块完成才能继续。
				// 以防内容块完成
				// 可能是 API 流在最后一个解析的内容块执行后完成，所以我们能够检测到超出边界并将 userMessageContentReady 设置为 true（注意，如果最后一个块已完成，则不应调用 presentAssistantMessage，因为它会再次呈现）
				// const completeBlocks = this.assistantMessageContent.filter((block) => !block.partial) // 如果流结束后有任何部分块，我们可以认为它们无效
				// if (this.currentStreamingContentIndex >= completeBlocks.length) {
				// 	this.userMessageContentReady = true
				// }

				await pWaitFor(() => this.userMessageContentReady)

				// 如果模型没有使用工具，那么我们需要告诉它使用工具或尝试完成
				const didToolUse = this.assistantMessageContent.some((block) => block.type === "tool_use")

				if (!didToolUse) {
					// 需要工具使用的正常请求
					this.userMessageContent.push({
						type: "text",
						text: formatResponse.noToolsUsed(),
					})
					this.consecutiveMistakeCount++
				}

				const recDidEndLoop = await this.recursivelyMakeClineRequests(this.userMessageContent)
				didEndLoop = recDidEndLoop
			} else {
				// 如果没有 assistant_responses，这意味着我们从 API 没有获得任何文本或 tool_use 内容块，我们应该假设这是一个错误
				await this.say("error", "意外的 API 响应：语言模型没有提供任何助手消息。这可能表明 API 或模型输出存在问题。")
				await this.addToApiConversationHistory({
					role: "assistant",
					content: [
						{
							type: "text",
							text: "失败：我没有提供响应。",
						},
					],
				})
			}

			return didEndLoop // 目前总是返回 false
		} catch (error) {
			// 这应该永远不会发生，因为唯一可能抛出错误的是 attemptApiRequest，它被包装在一个 try catch 中，如果 noButtonClicked，将清除当前任务并销毁此实例。但是为了避免未处理的 promise 拒绝，我们将结束此循环，这将结束此实例的执行（参见 startTask）
			return true // 需要为 true，这样父循环知道结束任务
		}
	}

	async loadContext(userContent: UserContent, includeFileDetails: boolean = false) {
		return await Promise.all([
			// 这是一个临时解决方案，用于从工具结果中动态加载上下文提及。它检查是否存在表示工具被拒绝并提供了反馈的标签（参见 formatToolDeniedFeedback、attemptCompletion、executeCommand 和 consecutiveMistakeCount >= 3）或 "<answer>"（参见 askFollowupQuestion），我们将所有用户生成的内容放在这些标签中，以便它们可以有效地用作标记，指示何时应该解析提及）。但是，如果我们将来允许多个工具响应，我们将需要专门在用户内容标签内解析提及。
			// （注意：这导致了 @/ 导入别名错误，其中文件内容也被解析，因为 v2 将工具结果转换为文本块）
			Promise.all(
				userContent.map(async (block) => {
					if (block.type === "text") {
						// 我们需要确保任何用户生成的内容都包含在这些标签之一中，以便我们知道解析提及
						// 修复：只解析这些标签之间的文本，而不是整个文本块，这可能包含其他工具结果。这是一个更大问题的一部分，我们不应该使用正则表达式来解析提及（例如，对于文件路径有空格的情况）
						if (
							block.text.includes("<feedback>") ||
							block.text.includes("<answer>") ||
							block.text.includes("<task>") ||
							block.text.includes("<user_message>")
						) {
							return {
								...block,
								text: await parseMentions(block.text, cwd, this.urlContentFetcher),
							}
						}
					}
					return block
				}),
			),
			this.getEnvironmentDetails(includeFileDetails),
		])
	}

	async getEnvironmentDetails(includeFileDetails: boolean = false) {
		let details = ""

		// Cline 了解用户是否从一个或没有文件转到另一个文件之间的消息可能很有用，所以我们总是包含这个上下文
		details += "\n\n# VSCode 可见文件"
		const visibleFilePaths = vscode.window.visibleTextEditors
			?.map((editor) => editor.document?.uri?.fsPath)
			.filter(Boolean)
			.map((absolutePath) => path.relative(cwd, absolutePath))

		// 通过 clineIgnoreController 过滤路径
		const allowedVisibleFiles = this.clineIgnoreController
			.filterPaths(visibleFilePaths)
			.map((p) => p.toPosix())
			.join("\n")

		if (allowedVisibleFiles) {
			details += `\n${allowedVisibleFiles}`
		} else {
			details += "\n(没有可见文件)"
		}

		details += "\n\n# VSCode 打开的标签页"
		const openTabPaths = vscode.window.tabGroups.all
			.flatMap((group) => group.tabs)
			.map((tab) => (tab.input as vscode.TabInputText)?.uri?.fsPath)
			.filter(Boolean)
			.map((absolutePath) => path.relative(cwd, absolutePath))

		// 通过 clineIgnoreController 过滤路径
		const allowedOpenTabs = this.clineIgnoreController
			.filterPaths(openTabPaths)
			.map((p) => p.toPosix())
			.join("\n")

		if (allowedOpenTabs) {
			details += `\n${allowedOpenTabs}`
		} else {
			details += "\n(没有打开的标签页)"
		}

		const busyTerminals = this.terminalManager.getTerminals(true)
		const inactiveTerminals = this.terminalManager.getTerminals(false)
		// const allTerminals = [...busyTerminals, ...inactiveTerminals]

		if (busyTerminals.length > 0 && this.didEditFile) {
			//  || this.didEditFile
			await setTimeoutPromise(300) // 保存文件后延迟，让终端赶上
		}

		// let terminalWasBusy = false
		if (busyTerminals.length > 0) {
			// 等待终端冷却
			// terminalWasBusy = allTerminals.some((t) => this.terminalManager.isProcessHot(t.id))
			await pWaitFor(() => busyTerminals.every((t) => !this.terminalManager.isProcessHot(t.id)), {
				interval: 100,
				timeout: 15_000,
			}).catch(() => {})
		}

		// 我们希望在终端冷却后获取诊断信息，原因有几个：终端可能正在搭建项目，开发服务器（如 webpack 编译器）会先重新编译，然后发送诊断信息等
		/*
		let diagnosticsDetails = ""
		const diagnostics = await this.diagnosticsMonitor.getCurrentDiagnostics(this.didEditFile || terminalWasBusy) // 如果 cline 运行了一个命令（例如 npm install）或编辑了工作区，则稍等以获取更新的诊断信息
		for (const [uri, fileDiagnostics] of diagnostics) {
			const problems = fileDiagnostics.filter((d) => d.severity === vscode.DiagnosticSeverity.Error)
			if (problems.length > 0) {
				diagnosticsDetails += `\n## ${path.relative(cwd, uri.fsPath)}`
				for (const diagnostic of problems) {
					// let severity = diagnostic.severity === vscode.DiagnosticSeverity.Error ? "错误" : "警告"
					const line = diagnostic.range.start.line + 1 // VSCode 行是 0 索引
					const source = diagnostic.source ? `[${diagnostic.source}] ` : ""
					diagnosticsDetails += `\n- ${source}第 ${line} 行: ${diagnostic.message}`
				}
			}
		}
		*/
		this.didEditFile = false // 重置，这让我们知道何时等待已保存的文件更新终端

		// 等待更新的诊断信息可以让终端输出尽可能最新
		let terminalDetails = ""
		if (busyTerminals.length > 0) {
			// 终端已冷却，让我们检索它们的输出
			terminalDetails += "\n\n# 正在运行的终端"
			for (const busyTerminal of busyTerminals) {
				terminalDetails += `\n## 原始命令: \`${busyTerminal.lastCommand}\``
				const newOutput = this.terminalManager.getUnretrievedOutput(busyTerminal.id)
				if (newOutput) {
					terminalDetails += `\n### 新输出\n${newOutput}`
				} else {
					// details += `\n(仍在运行，没有新输出)` // 不想在运行命令后立即显示这个
				}
			}
		}
		// 仅在有输出时显示非活动终端
		if (inactiveTerminals.length > 0) {
			const inactiveTerminalOutputs = new Map<number, string>()
			for (const inactiveTerminal of inactiveTerminals) {
				const newOutput = this.terminalManager.getUnretrievedOutput(inactiveTerminal.id)
				if (newOutput) {
					inactiveTerminalOutputs.set(inactiveTerminal.id, newOutput)
				}
			}
			if (inactiveTerminalOutputs.size > 0) {
				terminalDetails += "\n\n# 非活动终端"
				for (const [terminalId, newOutput] of inactiveTerminalOutputs) {
					const inactiveTerminal = inactiveTerminals.find((t) => t.id === terminalId)
					if (inactiveTerminal) {
						terminalDetails += `\n## ${inactiveTerminal.lastCommand}`
						terminalDetails += `\n### 新输出\n${newOutput}`
					}
				}
			}
		}

		// details += "\n\n# VSCode 工作区错误"
		// if (diagnosticsDetails) {
		// 	details += diagnosticsDetails
		// } else {
		// 	details += "\n(未检测到错误)"
		// }

		if (terminalDetails) {
			details += terminalDetails
		}

		// 添加当前时间信息和时区
		const now = new Date()
		const formatter = new Intl.DateTimeFormat(undefined, {
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
			hour12: true,
		})
		const timeZone = formatter.resolvedOptions().timeZone
		const timeZoneOffset = -now.getTimezoneOffset() / 60 // 转换为小时并反转符号以匹配常规表示法
		const timeZoneOffsetStr = `${timeZoneOffset >= 0 ? "+" : ""}${timeZoneOffset}:00`
		details += `\n\n# 当前时间\n${formatter.format(now)} (${timeZone}, UTC${timeZoneOffsetStr})`

		if (includeFileDetails) {
			details += `\n\n# 当前工作目录 (${cwd.toPosix()}) 文件\n`
			const isDesktop = arePathsEqual(cwd, path.join(os.homedir(), "Desktop"))
			if (isDesktop) {
				// 不想立即访问桌面，因为这会显示权限弹出窗口
				details += "(桌面文件未自动显示。如有需要，请使用 list_files 进行浏览。)"
			} else {
				const [files, didHitLimit] = await listFiles(cwd, true, 200)
				const result = formatResponse.formatFilesList(cwd, files, didHitLimit, this.clineIgnoreController)
				details += result
			}
		}

		details += "\n\n# 当前模式"
		if (this.chatSettings.mode === "plan") {
			details += "\n计划模式"
			details +=
				"\n在此模式下，您应专注于信息收集、提问和构建解决方案。一旦您有了计划，请使用 plan_mode_respond 工具与用户进行对话交流。在收集到您所需的所有信息之前，请勿使用 plan_mode_respond 工具，例如使用 read_file 或 ask_followup_question。"
			details +=
				"\n（请记住：如果用户似乎希望您使用仅在行动模式下可用的工具，您应要求用户“切换到行动模式”（使用这些词） - 他们必须手动使用下面的计划/行动切换按钮来执行此操作。您无法自己切换到行动模式，必须等待用户在对计划满意后自己执行此操作。您也不能提供切换到行动模式的选项，因为这将是您需要手动引导用户执行的事情。）"
		} else {
			details += "\n行动模式"
		}

		return `<environment_details>\n${details.trim()}\n</environment_details>`
	}
}
