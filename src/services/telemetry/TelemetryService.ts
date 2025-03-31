import { PostHog } from "posthog-node"
import * as vscode from "vscode"
import { version as extensionVersion } from "../../../package.json"

/**
 * PostHogClient 处理 Cline 扩展的遥测事件跟踪
 * 使用 PostHog 分析来跟踪用户交互和系统事件
 * 尊重用户隐私设置和 VSCode 的全局遥测配置
 */
class PostHogClient {
	// 用于跟踪用户交互和系统事件的事件常量
	private static readonly EVENTS = {
		// 用于跟踪对话和执行流程的任务相关事件
		TASK: {
			// 跟踪何时开始新的任务/对话
			CREATED: "task.created",
			// 跟踪何时重新打开任务
			RESTARTED: "task.restarted",
			// 跟踪任务完成时的接受或拒绝状态
			COMPLETED: "task.completed",
			// 跟踪在对话中发送消息的情况
			CONVERSATION_TURN: "task.conversation_turn",
			// 跟踪成本和使用分析的令牌消耗
			TOKEN_USAGE: "task.tokens",
			// 跟踪在计划和执行模式之间的切换
			MODE_SWITCH: "task.mode",
			// 跟踪基于 git 的检查点系统的使用情况 (shadow_git_initialized, commit_created, branch_created, branch_deleted_active, branch_deleted_inactive, restored)
			CHECKPOINT_USED: "task.checkpoint_used",
			// 跟踪何时使用工具（如文件操作、命令）
			TOOL_USED: "task.tool_used",
			// 跟踪何时从存储中加载历史任务
			HISTORICAL_LOADED: "task.historical_loaded",
			// 跟踪何时点击重试按钮以进行失败操作
			RETRY_CLICKED: "task.retry_clicked",
		},
		// 用于跟踪用户参与的 UI 交互事件
		UI: {
			// 跟踪用户在 API 提供者之间切换的情况
			PROVIDER_SWITCH: "ui.provider_switch",
			// 跟踪何时将图像附加到对话中
			IMAGE_ATTACHED: "ui.image_attached",
			// 跟踪一般按钮点击交互
			BUTTON_CLICK: "ui.button_click",
			// 跟踪何时打开市场视图
			MARKETPLACE_OPENED: "ui.marketplace_opened",
			// 跟踪何时打开设置面板
			SETTINGS_OPENED: "ui.settings_opened",
			// 跟踪何时打开任务历史视图
			HISTORY_OPENED: "ui.history_opened",
			// 跟踪何时从历史中移除任务
			TASK_POPPED: "ui.task_popped",
			// 跟踪何时选择不同的模型
			MODEL_SELECTED: "ui.model_selected",
			// 跟踪何时切换到计划模式
			PLAN_MODE_TOGGLED: "ui.plan_mode_toggled",
			// 跟踪何时切换到执行模式
			ACT_MODE_TOGGLED: "ui.act_mode_toggled",
		},
	}

	/** PostHogClient 的单例实例 */
	private static instance: PostHogClient
	/** 用于发送分析事件的 PostHog 客户端实例 */
	private client: PostHog
	/** 当前 VSCode 实例的唯一标识符 */
	private distinctId: string = vscode.env.machineId
	/** 根据用户和 VSCode 设置，遥测是否当前启用 */
	private telemetryEnabled: boolean = false
	/** 扩展的当前版本 */
	private readonly version: string = extensionVersion

	/**
	 * 私有构造函数以强制执行单例模式
	 * 使用配置初始化 PostHog 客户端
	 */
	private constructor() {
		this.client = new PostHog("phc_qfOAGxZw2TL5O8p9KYd9ak3bPBFzfjC8fy5L6jNWY7K", {
			host: "https://us.i.posthog.com",
			enableExceptionAutocapture: false,
		})
	}

	/**
	 * 根据用户偏好和 VSCode 设置更新遥测状态
	 * 仅在 VSCode 全局遥测启用且用户已选择加入时启用遥测
	 * @param didUserOptIn 用户是否明确选择加入遥测
	 */
	public updateTelemetryState(didUserOptIn: boolean): void {
		this.telemetryEnabled = false

		// 首先检查全局遥测级别 - 仅在级别为 "all" 时启用遥测
		const telemetryLevel = vscode.workspace.getConfiguration("telemetry").get<string>("telemetryLevel", "all")
		const globalTelemetryEnabled = telemetryLevel === "all"

		// 仅在全局 VSCode 遥测启用时启用遥测
		if (globalTelemetryEnabled) {
			this.telemetryEnabled = didUserOptIn
		}

		// 根据遥测偏好更新 PostHog 客户端状态
		if (this.telemetryEnabled) {
			this.client.optIn()
		} else {
			this.client.optOut()
		}
	}

	/**
	 * 获取或创建 PostHogClient 的单例实例
	 * @returns PostHogClient 实例
	 */
	public static getInstance(): PostHogClient {
		if (!PostHogClient.instance) {
			PostHogClient.instance = new PostHogClient()
		}
		return PostHogClient.instance
	}

	/**
	 * 如果启用了遥测，则捕获遥测事件
	 * @param event 要捕获的事件及其属性
	 */
	public capture(event: { event: string; properties?: any }): void {
		// 仅在启用遥测时发送事件
		if (this.telemetryEnabled) {
			// 在所有事件属性中包含扩展版本
			const propertiesWithVersion = {
				...event.properties,
				extension_version: this.version,
			}
			this.client.capture({ distinctId: this.distinctId, event: event.event, properties: propertiesWithVersion })
		}
	}

	// 任务事件
	/**
	 * 记录何时开始新的任务/对话
	 * @param taskId 新任务的唯一标识符
	 */
	public captureTaskCreated(taskId: string, apiProvider?: string) {
		this.capture({
			event: PostHogClient.EVENTS.TASK.CREATED,
			properties: { taskId, apiProvider },
		})
	}

	/**
	 * 记录何时重新启动任务/对话
	 * @param taskId 新任务的唯一标识符
	 */
	public captureTaskRestarted(taskId: string, apiProvider?: string) {
		this.capture({
			event: PostHogClient.EVENTS.TASK.RESTARTED,
			properties: { taskId, apiProvider },
		})
	}

	/**
	 * 记录何时调用任务完成结果工具，表示任务已完成
	 * @param taskId 任务的唯一标识符
	 */
	public captureTaskCompleted(taskId: string) {
		this.capture({
			event: PostHogClient.EVENTS.TASK.COMPLETED,
			properties: { taskId },
		})
	}

	/**
	 * 捕获发送的消息，并包括使用的 API 提供者和模型
	 * @param taskId 任务的唯一标识符
	 * @param provider API 提供者（例如，OpenAI，Anthropic）
	 * @param model 使用的特定模型（例如，GPT-4，Claude）
	 * @param source 消息的来源（"user" | "model"）。用于跟踪消息模式并识别用户何时需要纠正模型的响应。
	 */
	public captureConversationTurnEvent(
		taskId: string,
		provider: string = "unknown",
		model: string = "unknown",
		source: "user" | "assistant",
	) {
		// 确保提供了必需的参数
		if (!taskId || !provider || !model || !source) {
			console.warn("TelemetryService: 缺少消息捕获所需的参数")
			return
		}

		const properties: Record<string, any> = {
			taskId,
			provider,
			model,
			source,
			timestamp: new Date().toISOString(), // 为消息排序添加时间戳
		}

		this.capture({
			event: PostHogClient.EVENTS.TASK.CONVERSATION_TURN,
			properties,
		})
	}

	/**
	 * TODO
	 * 记录成本跟踪和使用分析的令牌使用指标
	 * @param taskId 任务的唯一标识符
	 * @param tokensIn 消耗的输入令牌数量
	 * @param tokensOut 生成的输出令牌数量
	 * @param model 用于令牌计算的模型
	 */
	public captureTokenUsage(taskId: string, tokensIn: number, tokensOut: number, model: string) {
		this.capture({
			event: PostHogClient.EVENTS.TASK.TOKEN_USAGE,
			properties: {
				taskId,
				tokensIn,
				tokensOut,
				model,
			},
		})
	}

	/**
	 * 记录任务在计划和执行模式之间切换的情况
	 * @param taskId 任务的唯一标识符
	 * @param mode 切换到的模式（计划或执行）
	 */
	public captureModeSwitch(taskId: string, mode: "plan" | "act") {
		this.capture({
			event: PostHogClient.EVENTS.TASK.MODE_SWITCH,
			properties: {
				taskId,
				mode,
			},
		})
	}

	// 工具事件
	/**
	 * 记录在任务执行期间使用工具的情况
	 * @param taskId 任务的唯一标识符
	 * @param tool 使用的工具名称
	 * @param autoApproved 工具是否根据设置自动批准
	 * @param success 工具执行是否成功
	 */
	public captureToolUsage(taskId: string, tool: string, autoApproved: boolean, success: boolean) {
		this.capture({
			event: PostHogClient.EVENTS.TASK.TOOL_USED,
			properties: {
				taskId,
				tool,
				autoApproved,
				success,
			},
		})
	}

	/**
	 * 记录与基于 git 的检查点系统的交互
	 * @param taskId 任务的唯一标识符
	 * @param action 检查点操作的类型
	 * @param durationMs 可选的操作持续时间（以毫秒为单位）
	 */
	public captureCheckpointUsage(
		taskId: string,
		action: "shadow_git_initialized" | "commit_created" | "restored" | "diff_generated",
		durationMs?: number,
	) {
		this.capture({
			event: PostHogClient.EVENTS.TASK.CHECKPOINT_USED,
			properties: {
				taskId,
				action,
				durationMs,
			},
		})
	}

	// UI 事件
	/**
	 * 记录用户在不同 API 提供者之间切换的情况
	 * @param from 先前的提供者名称
	 * @param to 新的提供者名称
	 * @param location 切换发生的位置（设置面板或底部栏）
	 * @param taskId 可选的任务标识符，如果切换发生在任务期间
	 */
	public captureProviderSwitch(from: string, to: string, location: "settings" | "bottom", taskId?: string) {
		this.capture({
			event: PostHogClient.EVENTS.UI.PROVIDER_SWITCH,
			properties: {
				from,
				to,
				location,
				taskId,
			},
		})
	}

	/**
	 * 记录何时将图像附加到对话中
	 * @param taskId 任务的唯一标识符
	 * @param imageCount 附加的图像数量
	 */
	public captureImageAttached(taskId: string, imageCount: number) {
		this.capture({
			event: PostHogClient.EVENTS.UI.IMAGE_ATTACHED,
			properties: {
				taskId,
				imageCount,
			},
		})
	}

	/**
	 * 记录 UI 中的一般按钮点击交互
	 * @param button 被点击的按钮的标识符
	 * @param taskId 可选的任务标识符，如果点击发生在任务期间
	 */
	public captureButtonClick(button: string, taskId?: string) {
		this.capture({
			event: PostHogClient.EVENTS.UI.BUTTON_CLICK,
			properties: {
				button,
				taskId,
			},
		})
	}

	/**
	 * 记录何时打开市场视图
	 * @param taskId 可选的任务标识符，如果市场在任务期间打开
	 */
	public captureMarketplaceOpened(taskId?: string) {
		this.capture({
			event: PostHogClient.EVENTS.UI.MARKETPLACE_OPENED,
			properties: {
				taskId,
			},
		})
	}

	/**
	 * 记录何时打开设置面板
	 * @param taskId 可选的任务标识符，如果设置在任务期间打开
	 */
	public captureSettingsOpened(taskId?: string) {
		this.capture({
			event: PostHogClient.EVENTS.UI.SETTINGS_OPENED,
			properties: {
				taskId,
			},
		})
	}

	/**
	 * 记录何时打开任务历史视图
	 * @param taskId 可选的任务标识符，如果历史在任务期间打开
	 */
	public captureHistoryOpened(taskId?: string) {
		this.capture({
			event: PostHogClient.EVENTS.UI.HISTORY_OPENED,
			properties: {
				taskId,
			},
		})
	}

	/**
	 * 记录何时从任务历史中移除任务
	 * @param taskId 正在移除的任务的唯一标识符
	 */
	public captureTaskPopped(taskId: string) {
		this.capture({
			event: PostHogClient.EVENTS.UI.TASK_POPPED,
			properties: {
				taskId,
			},
		})
	}

	/**
	 * 记录何时选择不同的模型进行使用
	 * @param model 选择的模型名称
	 * @param provider 选择的模型的提供者
	 * @param taskId 可选的任务标识符，如果模型在任务期间被选择
	 */
	public captureModelSelected(model: string, provider: string, taskId?: string) {
		this.capture({
			event: PostHogClient.EVENTS.UI.MODEL_SELECTED,
			properties: {
				model,
				provider,
				taskId,
			},
		})
	}

	/**
	 * 记录何时从存储中加载历史任务
	 * @param taskId 历史任务的唯一标识符
	 */
	public captureHistoricalTaskLoaded(taskId: string) {
		this.capture({
			event: PostHogClient.EVENTS.TASK.HISTORICAL_LOADED,
			properties: {
				taskId,
			},
		})
	}

	/**
	 * 记录何时点击重试按钮以进行失败操作
	 * @param taskId 正在重试的任务的唯一标识符
	 */
	public captureRetryClicked(taskId: string) {
		this.capture({
			event: PostHogClient.EVENTS.TASK.RETRY_CLICKED,
			properties: {
				taskId,
			},
		})
	}

	public isTelemetryEnabled(): boolean {
		return this.telemetryEnabled
	}

	public async shutdown(): Promise<void> {
		await this.client.shutdown()
	}
}

export const telemetryService = PostHogClient.getInstance()
