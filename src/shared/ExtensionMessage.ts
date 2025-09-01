// type that represents json data that is sent from extension to webview, called ExtensionMessage and has 'type' enum which can be 'plusButtonClicked' or 'settingsButtonClicked' or 'hello'
import { ApiConfiguration } from "./api"
import { AutoApprovalSettings } from "./AutoApprovalSettings"
import { BrowserSettings } from "./BrowserSettings"
import { FocusChainSettings } from "./FocusChainSettings"
import { Mode, OpenaiReasoningEffort } from "./storage/types"
import { HistoryItem } from "./HistoryItem"
import { TelemetrySetting } from "./TelemetrySetting"
import { ClineRulesToggles } from "./cline-rules"
import { UserInfo } from "./UserInfo"
import { McpDisplayMode } from "./McpDisplayMode"

// webview 持有扩展态信息的消息载体（当前仅一种消息类型：gRPC 响应）
export interface ExtensionMessage {
	type: "grpc_response" // 消息类型：gRPC 响应
	grpc_response?: GrpcResponse // gRPC 响应负载，可选（有时仅占位）
}

export type GrpcResponse = {
	message?: any // 经 JSON 序列化后的 protobuf 消息体
	request_id: string // 与请求对应的同一 ID，用于匹配请求-响应
	error?: string // 错误描述（存在表示请求失败或部分失败）
	is_streaming?: boolean // 是否为流式响应的一部分
	sequence_number?: number // 流式分片序号，用于排序
}

export type Platform = "aix" | "darwin" | "freebsd" | "linux" | "openbsd" | "sunos" | "win32" | "unknown"

export const DEFAULT_PLATFORM = "unknown"

export interface ExtensionState {
	isNewUser: boolean // 是否为首次使用（用于展示欢迎流程）
	welcomeViewCompleted: boolean // 欢迎/引导视图是否已完成
	apiConfiguration?: ApiConfiguration // 当前 API（模型 / Key 等）配置
	autoApprovalSettings: AutoApprovalSettings // 自动批准策略设置
	browserSettings: BrowserSettings // 浏览器相关设置
	remoteBrowserHost?: string // 远程浏览器主机地址（若使用远程执行）
	preferredLanguage?: string // 用户首选语言（UI / 提示）
	openaiReasoningEffort?: OpenaiReasoningEffort // OpenAI reasoning 深度选项（如 low / medium / high）
	mode: Mode // 当前运行模式（例如普通 / 推理模式等）
	checkpointTrackerErrorMessage?: string // 检查点跟踪器错误消息（若失败则存储）
	clineMessages: ClineMessage[] // 当前会话/上下文的消息列表
	currentTaskItem?: HistoryItem // 当前激活的历史任务项
	currentFocusChainChecklist?: string | null // Focus Chain 清单文本（或 null 表示未激活）
	mcpMarketplaceEnabled?: boolean // 是否启用 MCP 市场 / 服务发现
	mcpDisplayMode: McpDisplayMode // MCP 展示模式（侧边栏 / 合并等）
	planActSeparateModelsSetting: boolean // 是否“计划 / 执行”分离使用不同模型
	enableCheckpointsSetting?: boolean // 是否启用代码检查点功能
	platform: Platform // 当前运行平台（用于差异行为）
	shouldShowAnnouncement: boolean // 是否展示公告（版本更新等）
	taskHistory: HistoryItem[] // 历史任务列表
	telemetrySetting: TelemetrySetting // 遥测 / 统计开关设置
	shellIntegrationTimeout: number // shell 集成超时时间（毫秒或秒，依实现）
	terminalReuseEnabled?: boolean // 是否复用终端（避免频繁新建）
	terminalOutputLineLimit: number // 终端输出行数上限（截断控制）
	defaultTerminalProfile?: string // 默认终端配置名称
	uriScheme?: string // 自定义 URI Scheme（用于深链路等）
	userInfo?: UserInfo // 用户信息（已登录时）
	version: string // 扩展版本号
	distinctId: string // 匿名唯一识别 ID（用于分析 / 追踪）
	globalClineRulesToggles: ClineRulesToggles // 全局生效的 Cline 规则开关
	localClineRulesToggles: ClineRulesToggles // 当前工作区本地规则开关
	localWorkflowToggles: ClineRulesToggles // 本地工作流开关集合
	globalWorkflowToggles: ClineRulesToggles // 全局工作流开关集合
	localCursorRulesToggles: ClineRulesToggles // 与 Cursor 相关的本地规则开关
	localWindsurfRulesToggles: ClineRulesToggles // 与 Windsurf 相关的本地规则开关
	mcpResponsesCollapsed?: boolean // 是否折叠 MCP 响应区域
	strictPlanModeEnabled?: boolean // 是否开启严格规划模式
	focusChainSettings: FocusChainSettings // Focus Chain 配置项
	focusChainFeatureFlagEnabled?: boolean // Focus Chain 功能开关是否启用（特性旗标）
}

export interface ClineMessage {
	ts: number // 时间戳（毫秒）
	type: "ask" | "say" // 消息类型：ask=向用户/系统请求；say=输出陈述
	ask?: ClineAsk // 当 type=ask 时的具体子类型
	say?: ClineSay // 当 type=say 时的具体子类型
	text?: string // 纯文本内容（可能是模型输出或提示）
	reasoning?: string // 模型推理 / 思考链（可选，取决于模型）
	images?: string[] // 相关图片（Base64 / URL）引用
	files?: string[] // 涉及的文件路径数组
	partial?: boolean // 是否为流式部分内容（未完成）
	lastCheckpointHash?: string // 关联的最新代码检查点哈希
	isCheckpointCheckedOut?: boolean // 当前是否处于某个检查点的检出状态
	isOperationOutsideWorkspace?: boolean // 是否涉及工作区外部的文件/操作
	conversationHistoryIndex?: number // 在会话历史中的索引（用于恢复/引用）
	conversationHistoryDeletedRange?: [number, number] // 当为 API 请求截断历史时，记录被裁剪区间
}
// ask 类型的消息子分类(ask)
export type ClineAsk =
	| "followup"
	| "plan_mode_respond"
	| "command"
	| "command_output"
	| "completion_result"
	| "tool"
	| "api_req_failed"
	| "resume_task"
	| "resume_completed_task"
	| "mistake_limit_reached"
	| "auto_approval_max_req_reached"
	| "browser_action_launch"
	| "use_mcp_server"
	| "new_task"
	| "condense"
	| "summarize_task" // 总结任务
	| "report_bug" // 报告问题 / bug
// say 类型的消息子分类(type)
export type ClineSay =
	| "task"
	| "error"
	| "api_req_started"
	| "api_req_finished"
	| "text"
	| "reasoning"
	| "completion_result"
	| "user_feedback"
	| "user_feedback_diff"
	| "api_req_retried"
	| "command"
	| "command_output"
	| "tool"
	| "shell_integration_warning"
	| "browser_action_launch"
	| "browser_action"
	| "browser_action_result"
	| "mcp_server_request_started"
	| "mcp_server_response"
	| "mcp_notification"
	| "use_mcp_server"
	| "diff_error"
	| "deleted_api_reqs"
	| "clineignore_error"
	| "checkpoint_created"
	| "load_mcp_documentation"
	| "info" // 一般信息（例如重试状态）
	| "task_progress" // 任务进度通知
// 当 say 消息类型为 "tool" 时，对应的工具执行结果描述
export interface ClineSayTool {
	tool:
		| "editedExistingFile"
		| "newFileCreated"
		| "readFile"
		| "listFilesTopLevel"
		| "listFilesRecursive"
		| "listCodeDefinitionNames"
		| "searchFiles"
		| "webFetch"
		| "summarizeTask"
	path?: string
	diff?: string
	content?: string
	regex?: string
	filePattern?: string
	operationIsLocatedInWorkspace?: boolean
}

// 浏览器动作（需与系统提示保持同步）
export const browserActions = ["launch", "click", "type", "scroll_down", "scroll_up", "close"] as const
export type BrowserAction = (typeof browserActions)[number] // 等价联合："launch" | "click" | "type" | "scroll_down" | "scroll_up" | "close"

export interface ClineSayBrowserAction {
	action: BrowserAction // 动作类型
	coordinate?: string // 坐标（如点击 / 位置描述）
	text?: string // 输入文本（type 动作时）
}
// 浏览器动作结果载体
export type BrowserActionResult = {
	screenshot?: string // 截图（Base64 或路径）
	logs?: string // 控制台日志 / 提取文本
	currentUrl?: string // 当前页面 URL
	currentMousePosition?: string // 当前鼠标位置
}
// 请求使用某个 MCP 服务器的资源或工具
export interface ClineAskUseMcpServer {
	serverName: string // 服务器名称
	type: "use_mcp_tool" | "access_mcp_resource" // 使用工具 或 访问资源
	toolName?: string // 工具名称（当 type=use_mcp_tool）
	arguments?: string // 参数 JSON 字符串或序列化内容
	uri?: string // 资源 URI（当访问资源时）
}

export interface ClinePlanModeResponse {
	response: string // 文本响应（计划内容）
	options?: string[] // 可选项列表
	selected?: string // 选中的选项（若用户或系统已决策）
}

export interface ClineAskQuestion {
	question: string // 问题文本
	options?: string[] // 备选答案列表
	selected?: string // 已选择答案（可选）
}

export interface ClineAskNewTask {
	context: string // 新任务的上下文描述
}
// API 请求 / 推理调用的统计与状态信息
export interface ClineApiReqInfo {
	request?: string // 查询 / 请求提示内容
	tokensIn?: number // 输入 tokens 数
	tokensOut?: number // 输出 tokens 数
	cacheWrites?: number // 缓存写次数
	cacheReads?: number // 缓存读次数
	cost?: number // 预计 / 实际费用（单位按上层约定）
	cancelReason?: ClineApiReqCancelReason // 取消原因（若存在）
	streamingFailedMessage?: string // 流式失败的错误信息
	retryStatus?: {
		attempt: number // 当前重试次数（已尝试）
		maxAttempts: number // 最大允许重试次数
		delaySec: number // 下一次重试前延迟（秒）
		errorSnippet?: string // 最近错误片段 / 摘要
	}
}

export type ClineApiReqCancelReason = "streaming_failed" | "user_cancelled" | "retries_exhausted"

export const COMPLETION_RESULT_CHANGES_FLAG = "HAS_CHANGES" // 标记：本次 completion 结果包含对工作区的变更
