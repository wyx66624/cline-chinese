// 默认的 MCP（Model Context Protocol） 请求超时时间（秒），与 Anthropic MCP SDK 默认一致
export const DEFAULT_MCP_TIMEOUT_SECONDS = 60
// 允许的最小超时时间（秒），避免被设置成 0 导致立即失败
export const MIN_MCP_TIMEOUT_SECONDS = 1
// MCP 运行模式：
// full            -> 完整功能：可列出 / 使用工具、资源、模板等
// server-use-only -> 仅调用已配置服务器的工具，不进行市场 / 资源浏览等高级能力
// off             -> 关闭 MCP 功能（忽略服务器与工具）
export type McpMode = "full" | "server-use-only" | "off"

// 表示一个已注册 / 配置的 MCP 服务器实例及其元数据
export type McpServer = {
	name: string // 服务器显示名称（唯一标识人类可读部分）
	config: string // 原始配置字符串（例如路径 / 连接参数 / JSON）
	status: "connected" | "connecting" | "disconnected" // 当前连接状态
	error?: string // 最近一次连接或交互错误信息
	tools?: McpTool[] // 服务器暴露的工具列表
	resources?: McpResource[] // 静态 / 动态资源（可被读取）列表
	resourceTemplates?: McpResourceTemplate[] // 资源模板（需要填充参数生成具体资源）
	disabled?: boolean // 是否被用户禁用（即使配置存在也不参与调度）
	timeout?: number // 针对该服务器的单独超时（秒），优先于全局默认超时
}

// MCP 工具描述：可调用的操作单元（类似函数 / API）
export type McpTool = {
	name: string // 工具名称（调用时引用）
	description?: string // 人类可读说明，便于模型或用户理解用途
	inputSchema?: object // 输入参数 JSON Schema（用于校验 / 自动生成参数指引）
	autoApprove?: boolean // 是否允许在自动模式下跳过人工确认直接执行
}

// MCP 资源：可被读取（或下载）的内容实体（文件 / 文本 / 数据）
export type McpResource = {
	uri: string // 唯一 URI（用于拉取内容）
	name: string // 显示名称
	mimeType?: string // MIME 类型（决定解析方式，如 text/plain, application/json）
	description?: string // 描述信息
}

// MCP 资源模板：需要用户或系统填充变量生成具体资源的模板
export type McpResourceTemplate = {
	uriTemplate: string // 模板形式的 URI（可能包含占位符）
	name: string // 模板名称
	description?: string // 用途说明
	mimeType?: string // 生成资源的预期 MIME 类型
}

// 获取资源时的响应结构
export type McpResourceResponse = {
	_meta?: Record<string, any> // 元数据：服务端补充的调试 / 追踪信息
	contents: Array<{
		uri: string // 资源 URI（与请求相同或展开模板后的具体值）
		mimeType?: string // 内容类型
		text?: string // 文本内容（文本类资源）
		blob?: string // 二进制内容（Base64 编码）
	}>
}

// 工具调用返回内容（多段复合内容，可含文本 / 媒体 / 资源引用）
export type McpToolCallResponse = {
	_meta?: Record<string, any> // 元数据（调试、耗时、trace id 等）
	content: Array<
		| {
				type: "text" // 纯文本段
				text: string
		  }
		| {
				type: "image" // 图片数据（Base64）
				data: string
				mimeType: string
		  }
		| {
				type: "audio" // 音频数据（Base64）
				data: string
				mimeType: string
		  }
		| {
				type: "resource" // 资源结构（引用或内联）
				resource: {
					uri: string
					mimeType?: string
					text?: string
					blob?: string
				}
		  }
	>
	isError?: boolean // 是否为错误结果（即使结构返回也标记失败）
}

// MCP 市场中展示的单个条目信息（供用户浏览与安装）
export interface McpMarketplaceItem {
	mcpId: string // MCP 项目标识（内部 / 安装用）
	githubUrl: string // GitHub 仓库地址
	name: string // 展示名称
	author: string // 作者 / 组织
	description: string // 简要描述
	codiconIcon: string // VS Code codicon 图标类名（UI 使用）
	logoUrl: string // 自定义 Logo 链接
	category: string // 分类（例如 productivity, data, tooling 等）
	tags: string[] // 标签列表（搜索 / 过滤）
	requiresApiKey: boolean // 是否需要 API Key（安装或使用前置条件）
	readmeContent?: string // README 内容缓存（用于本地展示）
	llmsInstallationContent?: string // LLM 相关安装指引内容
	isRecommended: boolean // 是否官方推荐 / 精选
	githubStars: number // GitHub star 数（同步时快照）
	downloadCount: number // 安装 / 下载次数
	createdAt: string // 市场条目创建时间
	updatedAt: string // 市场条目更新时间
	lastGithubSync: string // 最近一次 GitHub 数据同步时间
}

// 市场目录（分页或完整清单的一个载体）
export interface McpMarketplaceCatalog {
	items: McpMarketplaceItem[] // 条目列表
}

// 下载 / 安装 某个 MCP 项目的响应结构
export interface McpDownloadResponse {
	mcpId: string // 项目标识
	githubUrl: string // 仓库地址
	name: string // 名称
	author: string // 作者
	description: string // 描述
	readmeContent: string // README 内容（用于本地渲染）
	llmsInstallationContent: string // LLM 安装指引内容
	requiresApiKey: boolean // 是否需要 API Key
}

// MCP 视图的当前选项卡：marketplace(市场) / addRemote(添加远程) / installed(已安装)
export type McpViewTab = "marketplace" | "addRemote" | "installed"
