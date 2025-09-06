import * as vscode from "vscode"
import { version as extensionVersion } from "../../../../package.json"
import { HostProvider } from "@hosts/host-provider"
import { ShowMessageType } from "@shared/proto/host/window"

import type { TaskFeedbackType } from "@shared/WebviewMessage"
import type { BrowserSettings } from "@shared/BrowserSettings"
import type { PostHogClientProvider } from "../PostHogClientProvider"
import { Mode } from "@/shared/storage/types"
import { ClineAccountUserInfo } from "@/services/auth/AuthService"

/**
 * TelemetryService
 * English: Centralized telemetry collection & forwarding to PostHog. Respects user + VS Code settings.
 * 中文：集中管理并发送遥测事件的服务，所有事件在这里统一封装后交给 PostHogClientProvider 发送；
 *  - 会自动附加扩展版本、是否开发模式等公共属性；
 *  - 受 VS Code 全局遥测开关与用户自定义设置双重约束；
 *  - 支持对不同“类别”做精细开关（如 browser / focus_chain / checkpoints）。
 * 若进行“内核裁剪”且不需要遥测，可：
 *  1. 删除本文件；
 *  2. 在引用处（telemetryService.xxx）替换为空实现（No-Op）对象，只保留必要类型定义；
 *  3. 移除 PostHogClientProvider、FeatureFlagsService、ErrorService 及相关依赖。
 */

/**
 * Represents telemetry event categories that can be individually enabled or disabled
 * 中文：可单独启用/禁用的分类；新增分类时需：
 *  1. 在类型里补充
 *  2. 在 telemetryCategoryEnabled 初始 Map 中给默认值
 *  3. 在对应 capture 方法前加 isCategoryEnabled 判断。
 */
type TelemetryCategory = "checkpoints" | "browser" | "focus_chain"

/** 最大错误消息长度，避免发送超长文本 */
const MAX_ERROR_MESSAGE_LENGTH = 500

export class TelemetryService {
	// 分类开关 Map：可按需关闭某些高频或敏感事件
	private telemetryCategoryEnabled: Map<TelemetryCategory, boolean> = new Map([
		["checkpoints", false], // 默认为关闭（示例：在还未稳定时避免早期噪声）
		["browser", true], // 浏览器工具相关
		["focus_chain", true], // Focus Chain 功能相关
	])

	// 事件名称常量：统一管理，便于搜索/避免硬编码拼写错误
	private static readonly EVENTS = {
		// Task-related events for tracking conversation and execution flow

		USER: {
			OPT_OUT: "user.opt_out",
			TELEMETRY_ENABLED: "user.telemetry_enabled",
			EXTENSION_ACTIVATED: "user.extension_activated",
		},
		TASK: {
			// Tracks when a new task/conversation is started
			CREATED: "task.created",
			// Tracks when a task is reopened
			RESTARTED: "task.restarted",
			// Tracks when a task is finished, with acceptance or rejection status
			COMPLETED: "task.completed",
			// Tracks user feedback on completed tasks
			FEEDBACK: "task.feedback",
			// Tracks when a message is sent in a conversation
			CONVERSATION_TURN: "task.conversation_turn",
			// Tracks token consumption for cost and usage analysis
			TOKEN_USAGE: "task.tokens",
			// Tracks switches between plan and act modes
			MODE_SWITCH: "task.mode",
			// Tracks when users select an option from AI-generated followup questions
			OPTION_SELECTED: "task.option_selected",
			// Tracks when users type a custom response instead of selecting an option from AI-generated followup questions
			OPTIONS_IGNORED: "task.options_ignored",
			// Tracks usage of the git-based checkpoint system (shadow_git_initialized, commit_created, branch_created, branch_deleted_active, branch_deleted_inactive, restored)
			CHECKPOINT_USED: "task.checkpoint_used",
			// Tracks when tools (like file operations, commands) are used
			TOOL_USED: "task.tool_used",
			// Tracks when a historical task is loaded from storage
			HISTORICAL_LOADED: "task.historical_loaded",
			// Tracks when the retry button is clicked for failed operations
			RETRY_CLICKED: "task.retry_clicked",
			// Tracks when a diff edit (replace_in_file) operation fails
			DIFF_EDIT_FAILED: "task.diff_edit_failed",
			// Tracks when the browser tool is started
			BROWSER_TOOL_START: "task.browser_tool_start",
			// Tracks when the browser tool is completed
			BROWSER_TOOL_END: "task.browser_tool_end",
			// Tracks when browser errors occur
			BROWSER_ERROR: "task.browser_error",
			// Tracks Gemini API specific performance metrics
			GEMINI_API_PERFORMANCE: "task.gemini_api_performance",
			// Tracks when API providers return errors
			PROVIDER_API_ERROR: "task.provider_api_error",
			// Tracks when users enable the focus chain feature
			FOCUS_CHAIN_ENABLED: "task.focus_chain_enabled",
			// Tracks when users disable the focus chain feature
			FOCUS_CHAIN_DISABLED: "task.focus_chain_disabled",
			// Tracks when the first focus chain return is returned by the model
			FOCUS_CHAIN_PROGRESS_FIRST: "task.focus_chain_progress_first",
			// Tracks when subsequent focus chain list returns are returned
			FOCUS_CHAIN_PROGRESS_UPDATE: "task.focus_chain_progress_update",
			// Tracks the statusn of the focus chain list when the task reaches a task completion state
			FOCUS_CHAIN_INCOMPLETE_ON_COMPLETION: "task.focus_chain_incomplete_on_completion",
			// Tracks when users click to open the focus chain markdfown file
			FOCUS_CHAIN_LIST_OPENED: "task.focus_chain_list_opened",
			// Tracks when users save and write to the focus chain markdown file
			FOCUS_CHAIN_LIST_WRITTEN: "task.focus_chain_list_written",
		},
		// UI interaction events for tracking user engagement
		UI: {
			// Tracks when a different model is selected
			MODEL_SELECTED: "ui.model_selected",
			// Tracks when users use the "favorite" button in the model picker
			MODEL_FAVORITE_TOGGLED: "ui.model_favorite_toggled",
			// Tracks when a button is clicked
			BUTTON_CLICKED: "ui.button_clicked",
		},
	}

	/** 当前扩展版本 */
	private readonly version: string = extensionVersion
	/** 是否处于开发模式（通过环境变量） */
	private readonly isDev = process.env.IS_DEV

	/**
	 * @param provider PostHogClientProvider 用于真正上报事件
	 */
	public constructor(private provider: PostHogClientProvider) {
		this.capture({ event: TelemetryService.EVENTS.USER.TELEMETRY_ENABLED })
		console.info("[TelemetryService] Initialized with PostHogClientProvider")
	}

	/**
	 * 根据 VS Code 全局与用户选择更新遥测状态。
	 * @param didUserOptIn 用户是否在扩展层面选择开启
	 */
	public async updateTelemetryState(didUserOptIn: boolean): Promise<void> {
		// First check global telemetry level - telemetry should only be enabled when level is "all"

		// We only enable telemetry if global vscode telemetry is enabled
		if (!vscode.env.isTelemetryEnabled) {
			// Only show warning if user has opted in to Cline telemetry but VS Code telemetry is disabled
			if (didUserOptIn) {
				const isVsCodeHost = vscode?.env?.uriScheme === "vscode"
				if (isVsCodeHost) {
					void HostProvider.window
						.showMessage({
							type: ShowMessageType.WARNING,
							message:
								"Anonymous Cline error and usage reporting is enabled, but VSCode telemetry is disabled. To enable error and usage reporting for this extension, enable VSCode telemetry in settings.",
							options: {
								items: ["Open Settings"],
							},
						})
						.then((response: { selectedOption?: string } | undefined) => {
							if (response && response.selectedOption === "Open Settings") {
								void vscode.commands.executeCommand("workbench.action.openSettings", "telemetry.telemetryLevel")
							}
						})
				} else {
					void HostProvider.window.showMessage({
						type: ShowMessageType.WARNING,
						message: "Anonymous Cline error and usage reporting is enabled, but host telemetry is disabled.",
					})
				}
			}
		}

		this.provider.toggleOptIn(didUserOptIn)
	}

	/**
	 * 附加公共属性（扩展版本、是否开发模式）。
	 */
	private addProperties(properties: any): any {
		return {
			...properties,
			extension_version: this.version,
			is_dev: this.isDev,
		}
	}

	/**
	 * 统一发送入口：外部所有 captureXXX 调用最终汇聚到这里。
	 */
	public capture(event: { event: string; properties?: unknown }): void {
		const propertiesWithVersion = this.addProperties(event.properties)

		// Use the provider's log method instead of direct client capture
		this.provider.log(event.event, propertiesWithVersion)
	}

	/** 扩展被激活 */
	public captureExtensionActivated() {
		// Use provider's log method for the activation event
		this.provider.log(TelemetryService.EVENTS.USER.EXTENSION_ACTIVATED)
	}

	/** 账户识别事件（与 PostHog identify 结合） */
	public identifyAccount(userInfo: ClineAccountUserInfo) {
		const propertiesWithVersion = this.addProperties({})

		// Use the provider's log method instead of direct client capture
		this.provider.identifyAccount(userInfo, propertiesWithVersion)
	}

	// Task events
	/** 创建新任务 */
	public captureTaskCreated(ulid: string, apiProvider?: string) {
		this.capture({
			event: TelemetryService.EVENTS.TASK.CREATED,
			properties: { ulid, apiProvider },
		})
	}

	/** 重新开始任务 */
	public captureTaskRestarted(ulid: string, apiProvider?: string) {
		this.capture({
			event: TelemetryService.EVENTS.TASK.RESTARTED,
			properties: { ulid, apiProvider },
		})
	}

	/** 任务宣告完成 */
	public captureTaskCompleted(ulid: string) {
		this.capture({
			event: TelemetryService.EVENTS.TASK.COMPLETED,
			properties: { ulid },
		})
	}

	/** 会话轮次（消息发送/接收） */
	public captureConversationTurnEvent(
		ulid: string,
		provider: string = "unknown",
		model: string = "unknown",
		source: "user" | "assistant",
		tokenUsage: {
			tokensIn?: number
			tokensOut?: number
			cacheWriteTokens?: number
			cacheReadTokens?: number
			totalCost?: number
		} = {},
	) {
		// Ensure required parameters are provided
		if (!ulid || !provider || !model || !source) {
			console.warn("TelemetryService: Missing required parameters for message capture")
			return
		}

		const properties: Record<string, unknown> = {
			ulid,
			provider,
			model,
			source,
			timestamp: new Date().toISOString(), // Add timestamp for message sequencing
			...tokenUsage,
		}

		this.capture({
			event: TelemetryService.EVENTS.TASK.CONVERSATION_TURN,
			properties,
		})
	}

	/** 统计 token 消耗 */
	public captureTokenUsage(ulid: string, tokensIn: number, tokensOut: number, model: string) {
		this.capture({
			event: TelemetryService.EVENTS.TASK.TOKEN_USAGE,
			properties: {
				ulid,
				tokensIn,
				tokensOut,
				model,
			},
		})
	}

	/** 模式切换（plan/act） */
	public captureModeSwitch(ulid: string, mode: Mode) {
		this.capture({
			event: TelemetryService.EVENTS.TASK.MODE_SWITCH,
			properties: {
				ulid,
				mode,
			},
		})
	}

	/** 任务反馈（点赞/点踩） */
	public captureTaskFeedback(ulid: string, feedbackType: TaskFeedbackType) {
		console.info("TelemetryService: Capturing task feedback", {
			ulid,
			feedbackType,
		})
		this.capture({
			event: TelemetryService.EVENTS.TASK.FEEDBACK,
			properties: {
				ulid,
				feedbackType,
			},
		})
	}

	// Tool events
	/** 工具调用 */
	public captureToolUsage(ulid: string, tool: string, modelId: string, autoApproved: boolean, success: boolean) {
		this.capture({
			event: TelemetryService.EVENTS.TASK.TOOL_USED,
			properties: {
				ulid,
				tool,
				autoApproved,
				success,
				modelId,
			},
		})
	}

	/** git 检查点系统互动 */
	public captureCheckpointUsage(
		ulid: string,
		action: "shadow_git_initialized" | "commit_created" | "restored" | "diff_generated",
		durationMs?: number,
	) {
		if (!this.isCategoryEnabled("checkpoints")) {
			return
		}

		this.capture({
			event: TelemetryService.EVENTS.TASK.CHECKPOINT_USED,
			properties: {
				ulid,
				action,
				durationMs,
			},
		})
	}

	/** diff 编辑失败 */
	public captureDiffEditFailure(ulid: string, modelId: string, errorType?: string) {
		this.capture({
			event: TelemetryService.EVENTS.TASK.DIFF_EDIT_FAILED,
			properties: {
				ulid,
				errorType,
				modelId,
			},
		})
	}

	/** 模型选择 */
	public captureModelSelected(model: string, provider: string, ulid?: string) {
		this.capture({
			event: TelemetryService.EVENTS.UI.MODEL_SELECTED,
			properties: {
				model,
				provider,
				ulid,
			},
		})
	}

	/** 浏览器工具开始 */
	public captureBrowserToolStart(ulid: string, browserSettings: BrowserSettings) {
		if (!this.isCategoryEnabled("browser")) {
			return
		}

		this.capture({
			event: TelemetryService.EVENTS.TASK.BROWSER_TOOL_START,
			properties: {
				ulid,
				viewport: browserSettings.viewport,
				isRemote: !!browserSettings.remoteBrowserEnabled,
				remoteBrowserHost: browserSettings.remoteBrowserHost,
				timestamp: new Date().toISOString(),
			},
		})
	}

	/** 浏览器工具结束 */
	public captureBrowserToolEnd(
		ulid: string,
		stats: {
			actionCount: number
			duration: number
			actions?: string[]
		},
	) {
		if (!this.isCategoryEnabled("browser")) {
			return
		}

		this.capture({
			event: TelemetryService.EVENTS.TASK.BROWSER_TOOL_END,
			properties: {
				ulid,
				actionCount: stats.actionCount,
				duration: stats.duration,
				actions: stats.actions,
				timestamp: new Date().toISOString(),
			},
		})
	}

	/** 浏览器相关错误 */
	public captureBrowserError(
		ulid: string,
		errorType: string,
		errorMessage: string,
		context?: {
			action?: string
			url?: string
			isRemote?: boolean
			[key: string]: unknown
		},
	) {
		if (!this.isCategoryEnabled("browser")) {
			return
		}

		this.capture({
			event: TelemetryService.EVENTS.TASK.BROWSER_ERROR,
			properties: {
				ulid,
				errorType,
				errorMessage,
				context,
				timestamp: new Date().toISOString(),
			},
		})
	}

	/** 选中了模型提供的后续建议选项 */
	public captureOptionSelected(ulid: string, qty: number, mode: Mode) {
		this.capture({
			event: TelemetryService.EVENTS.TASK.OPTION_SELECTED,
			properties: {
				ulid,
				qty,
				mode,
			},
		})
	}

	/** 忽略选项并输入自定义回复 */
	public captureOptionsIgnored(ulid: string, qty: number, mode: Mode) {
		this.capture({
			event: TelemetryService.EVENTS.TASK.OPTIONS_IGNORED,
			properties: {
				ulid,
				qty,
				mode,
			},
		})
	}

	/** Gemini API 性能指标 */
	public captureGeminiApiPerformance(
		ulid: string,
		modelId: string,
		data: {
			ttftSec?: number
			totalDurationSec?: number
			promptTokens: number
			outputTokens: number
			cacheReadTokens: number
			cacheHit: boolean
			cacheHitPercentage?: number
			apiSuccess: boolean
			apiError?: string
			throughputTokensPerSec?: number
		},
	) {
		this.capture({
			event: TelemetryService.EVENTS.TASK.GEMINI_API_PERFORMANCE,
			properties: {
				ulid,
				modelId,
				...data,
			},
		})
	}

	/** 模型收藏/取消收藏 */
	public captureModelFavoritesUsage(model: string, isFavorited: boolean) {
		this.capture({
			event: TelemetryService.EVENTS.UI.MODEL_FAVORITE_TOGGLED,
			properties: {
				model,
				isFavorited,
			},
		})
	}

	/** 任意按钮点击 */
	public captureButtonClick(button: string, ulid?: string) {
		this.capture({
			event: TelemetryService.EVENTS.UI.BUTTON_CLICKED,
			properties: {
				button,
				ulid,
			},
		})
	}

	/** 模型/提供商 API 错误 */
	public captureProviderApiError(args: {
		ulid: string
		model: string
		errorMessage: string
		errorStatus?: number | undefined
		requestId?: string | undefined
	}) {
		this.capture({
			event: TelemetryService.EVENTS.TASK.PROVIDER_API_ERROR,
			properties: {
				...args,
				errorMessage: args.errorMessage.substring(0, MAX_ERROR_MESSAGE_LENGTH), // Truncate long error messages
				timestamp: new Date().toISOString(),
			},
		})
	}

	/** Focus Chain 功能开关 */
	public captureFocusChainToggle(enabled: boolean) {
		if (!this.isCategoryEnabled("focus_chain")) {
			return
		}

		this.capture({
			event: enabled ? TelemetryService.EVENTS.TASK.FOCUS_CHAIN_ENABLED : TelemetryService.EVENTS.TASK.FOCUS_CHAIN_DISABLED,
			properties: {
				enabled,
			},
		})
	}

	/** Focus Chain 首次返回 */
	public captureFocusChainProgressFirst(ulid: string, totalItems: number) {
		if (!this.isCategoryEnabled("focus_chain")) {
			return
		}

		this.capture({
			event: TelemetryService.EVENTS.TASK.FOCUS_CHAIN_PROGRESS_FIRST,
			properties: {
				ulid,
				totalItems,
			},
		})
	}

	/** Focus Chain 中途更新 */
	public captureFocusChainProgressUpdate(ulid: string, totalItems: number, completedItems: number) {
		if (!this.isCategoryEnabled("focus_chain")) {
			return
		}

		this.capture({
			event: TelemetryService.EVENTS.TASK.FOCUS_CHAIN_PROGRESS_UPDATE,
			properties: {
				ulid,
				totalItems,
				completedItems,
				completionPercentage: totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0,
			},
		})
	}

	/** Focus Chain 任务结束但尚未全部完成 */
	public captureFocusChainIncompleteOnCompletion(
		ulid: string,
		totalItems: number,
		completedItems: number,
		incompleteItems: number,
	) {
		if (!this.isCategoryEnabled("focus_chain")) {
			return
		}

		this.capture({
			event: TelemetryService.EVENTS.TASK.FOCUS_CHAIN_INCOMPLETE_ON_COMPLETION,
			properties: {
				ulid,
				totalItems,
				completedItems,
				incompleteItems,
				completionPercentage: totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0,
			},
		})
	}

	/** 打开 Focus Chain 列表文件 */
	public captureFocusChainListOpened(ulid: string) {
		if (!this.isCategoryEnabled("focus_chain")) {
			return
		}

		this.capture({
			event: TelemetryService.EVENTS.TASK.FOCUS_CHAIN_LIST_OPENED,
			properties: {
				ulid,
			},
		})
	}

	/** 写入 Focus Chain 列表文件 */
	public captureFocusChainListWritten(ulid: string) {
		if (!this.isCategoryEnabled("focus_chain")) {
			return
		}

		this.capture({
			event: TelemetryService.EVENTS.TASK.FOCUS_CHAIN_LIST_WRITTEN,
			properties: {
				ulid,
			},
		})
	}

	/** 分类开关判定 */
	public isCategoryEnabled(category: TelemetryCategory): boolean {
		// Default to true if category has not been explicitly configured
		return this.telemetryCategoryEnabled.get(category) ?? true
	}
}
