import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import { sendMcpServersUpdate } from "@core/controller/mcp/subscribeToMcpServers"
import { GlobalFileNames } from "@core/storage/disk"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
	CallToolResultSchema,
	ListResourcesResultSchema,
	ListResourceTemplatesResultSchema,
	ListToolsResultSchema,
	ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js"
import {
	DEFAULT_MCP_TIMEOUT_SECONDS,
	McpResource,
	McpResourceResponse,
	McpResourceTemplate,
	McpServer,
	McpTool,
	McpToolCallResponse,
	MIN_MCP_TIMEOUT_SECONDS,
} from "@shared/mcp"
import { convertMcpServersToProtoMcpServers } from "@shared/proto-conversions/mcp/mcp-server-conversion"
import { fileExistsAtPath } from "@utils/fs"
import { secondsToMs } from "@utils/time"
import chokidar, { FSWatcher } from "chokidar"
import deepEqual from "fast-deep-equal"
import * as fs from "fs/promises"
import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import * as path from "path"
import ReconnectingEventSource from "reconnecting-eventsource"
import * as vscode from "vscode"
import { z } from "zod"
import { FileChangeEvent_ChangeType, SubscribeToFileRequest } from "../../shared/proto/host/watch"
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./constants"
import { BaseConfigSchema, McpSettingsSchema, ServerConfigSchema } from "./schemas"
import { McpConnection, McpServerConfig, Transport } from "./types"
/**
 * McpHub 负责：
 *  1. 读取 & 监听 MCP 配置文件(mcp.json)并维护连接集合
 *  2. 按服务器类型建立对应传输 (stdio / sse / streamableHttp)
 *  3. 拉取工具、资源、模板列表并缓存
 *  4. 处理通知 (notifications/message) 与回调派发
 *  5. 提供外部操作接口：增删改服务器、调用工具、读取资源、切换自动批准等
 */
export class McpHub {
	/** 返回存放 MCP servers（可执行或脚本）的根路径函数 */
	getMcpServersPath: () => Promise<string>
	/** 返回配置文件所在目录路径函数 */
	private getSettingsDirectoryPath: () => Promise<string>
	/** 客户端版本（用于向服务器标识自身） */
	private clientVersion: string

	/** VSCode 可释放资源集合（文件订阅等） */
	private disposables: vscode.Disposable[] = []
	/** 监听设置文件的 VSCode watcher（当前 gRPC 已订阅，可空） */
	private settingsWatcher?: vscode.FileSystemWatcher
	/** 针对 stdio 服务器产物（build/index.js 等）的文件变更 watcher 映射 */
	private fileWatchers: Map<string, FSWatcher> = new Map()
	/** 当前所有服务器连接（含禁用态占位） */
	connections: McpConnection[] = []
	/** 全局连接/重连过程中的忙碌标记，避免并发操作 */
	isConnecting: boolean = false

	// 暂存服务器通知（若当前没有活动回调，则先缓存供前端轮询/拉取）
	private pendingNotifications: Array<{
		serverName: string
		level: string
		message: string
		timestamp: number
	}> = []

	// 当前活动任务的实时通知回调
	private notificationCallback?: (serverName: string, level: string, message: string) => void

	constructor(
		getMcpServersPath: () => Promise<string>,
		getSettingsDirectoryPath: () => Promise<string>,
		clientVersion: string,
	) {
		this.getMcpServersPath = getMcpServersPath
		this.getSettingsDirectoryPath = getSettingsDirectoryPath
		this.clientVersion = clientVersion
		this.watchMcpSettingsFile() // 启动对配置文件的订阅
		this.initializeMcpServers() // 初次加载配置并建立连接
	}

	/** 获取当前启用状态的服务器（过滤掉 disabled） */
	getServers(): McpServer[] {
		return this.connections.filter((conn) => !conn.server.disabled).map((conn) => conn.server)
	}

	/**
	 * 确保 MCP 设置文件存在，不存在则以空模板创建
	 * 获取mcpsetting.json的路径
	 */
	async getMcpSettingsFilePath(): Promise<string> {
		const mcpSettingsFilePath = path.join(await this.getSettingsDirectoryPath(), GlobalFileNames.mcpSettings)
		const fileExists = await fileExistsAtPath(mcpSettingsFilePath)
		if (!fileExists) {
			await fs.writeFile(
				mcpSettingsFilePath,
				`{
  "mcpServers": {
    
  }
}`,
			)
		}
		return mcpSettingsFilePath
	}

	/** 读取 + 解析 + Schema 校验配置文件；失败返回 undefined
	 * 读取和验证mcpsetting.json格式
	 */
	private async readAndValidateMcpSettingsFile(): Promise<z.infer<typeof McpSettingsSchema> | undefined> {
		try {
			const settingsPath = await this.getMcpSettingsFilePath()
			const content = await fs.readFile(settingsPath, "utf-8")

			let config: any

			// Parse JSON file content
			try {
				config = JSON.parse(content)
			} catch (error) {
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: "Invalid MCP settings format. Please ensure your settings follow the correct JSON format.",
				})
				return undefined
			}

			// Validate against schema 解析结果通过各式验证
			const result = McpSettingsSchema.safeParse(config)
			if (!result.success) {
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: "Invalid MCP settings schema.",
				})
				return undefined
			}

			return result.data
		} catch (error) {
			console.error("Failed to read MCP settings:", error)
			return undefined
		}
	}

	/** 订阅配置文件变更（通过底层 gRPC WatchService） */
	private async watchMcpSettingsFile(): Promise<void> {
		const settingsPath = await this.getMcpSettingsFilePath()

		// Subscribe to file changes using the gRPC WatchService
		//console.log("[DEBUG] subscribing to mcp file changes")
		const cancelSubscription = HostProvider.watch.subscribeToFile(
			SubscribeToFileRequest.create({
				path: settingsPath,
			}),
			{
				onResponse: async (response: any) => {
					// console.log(
					// 	`[DEBUG] MCP settings ${response.type === FileChangeEvent_ChangeType.CHANGED ? "changed" : "event"}`,
					// )

					// Only process the file if it was changed (not created or deleted)
					if (response.type === FileChangeEvent_ChangeType.CHANGED) {
						const settings = await this.readAndValidateMcpSettingsFile()
						if (settings) {
							try {
								await this.updateServerConnections(settings.mcpServers)
							} catch (error) {
								console.error("Failed to process MCP settings change:", error)
							}
						}
					}
				},
				onError: (error: any) => {
					console.error("Error watching MCP settings file:", error)
				},
				onComplete: () => {
					console.log("[DEBUG] MCP settings file watch completed")
				},
			},
		)

		// Add the cancellation function to disposables
		this.disposables.push({ dispose: cancelSubscription })
	}

	/** 首次初始化：读取配置并建立连接 */
	private async initializeMcpServers(): Promise<void> {
		const settings = await this.readAndValidateMcpSettingsFile()
		if (settings) {
			await this.updateServerConnections(settings.mcpServers)
		}
	}

	/** 按名称查找连接对象
	 * "rpc": 代表由外部（通常是前端 Webview 通过扩展暴露的命令 / gRPC / Host 层请求）发起的显式操作。
	 * "internal": 代表后端内部逻辑自主触发的更新，不是直接响应某个前端 RPC 调用。
	 */
	private findConnection(name: string, source: "rpc" | "internal"): McpConnection | undefined {
		return this.connections.find((conn) => conn.server.name === name)
	}

	/** 建立单个服务器连接（含禁用占位、通知处理、初始资源加载） */
	private async connectToServer(
		name: string,
		config: z.infer<typeof ServerConfigSchema>,
		source: "rpc" | "internal",
	): Promise<void> {
		// Remove existing connection if it exists (should never happen, the connection should be deleted beforehand)
		this.connections = this.connections.filter((conn) => conn.server.name !== name)

		if (config.disabled) {
			//console.log(`[MCP Debug] Creating disabled connection object for server "${name}"`)
			// Create a connection object for disabled server so it appears in UI
			const disabledConnection: McpConnection = {
				server: {
					name,
					config: JSON.stringify(config),
					status: "disconnected",
					disabled: true,
				},
				client: null as unknown as Client,
				transport: null as unknown as Transport,
			}
			this.connections.push(disabledConnection)
			return
		}

		try {
			// Each MCP server requires its own transport connection and has unique capabilities, configurations, and error handling. Having separate clients also allows proper scoping of resources/tools and independent server management like reconnection.
			const client = new Client(
				{
					name: "Cline",
					version: this.clientVersion,
				},
				{
					capabilities: {},
				},
			)

			let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport

			switch (config.type) {
				case "stdio": {
					transport = new StdioClientTransport({
						command: config.command,
						args: config.args,
						cwd: config.cwd,
						env: {
							// ...(config.env ? await injectEnv(config.env) : {}), // Commented out as injectEnv is not found
							...getDefaultEnvironment(),
							...(config.env || {}), // Use config.env directly or an empty object
						},
						stderr: "pipe",
					})

					transport.onerror = async (error) => {
						console.error(`Transport error for "${name}":`, error)
						const connection = this.findConnection(name, source)
						if (connection) {
							connection.server.status = "disconnected"
							this.appendErrorMessage(connection, error instanceof Error ? error.message : `${error}`)
						}
						await this.notifyWebviewOfServerChanges()
					}

					transport.onclose = async () => {
						const connection = this.findConnection(name, source)
						if (connection) {
							connection.server.status = "disconnected"
						}
						await this.notifyWebviewOfServerChanges()
					}

					await transport.start()
					const stderrStream = transport.stderr
					if (stderrStream) {
						stderrStream.on("data", async (data: Buffer) => {
							const output = data.toString()
							const isInfoLog = /INFO/i.test(output)

							if (isInfoLog) {
								console.log(`Server "${name}" info:`, output)
							} else {
								console.error(`Server "${name}" stderr:`, output)
								const connection = this.findConnection(name, source)
								if (connection) {
									this.appendErrorMessage(connection, output)
									if (connection.server.status === "disconnected") {
										await this.notifyWebviewOfServerChanges()
									}
								}
							}
						})
					} else {
						console.error(`No stderr stream for ${name}`)
					}
					transport.start = async () => {}
					break
				}
				case "sse": {
					const sseOptions = {
						requestInit: {
							headers: config.headers,
						},
					}
					const reconnectingEventSourceOptions = {
						max_retry_time: 5000,
						withCredentials: config.headers?.["Authorization"] ? true : false,
					}
					global.EventSource = ReconnectingEventSource
					transport = new SSEClientTransport(new URL(config.url), {
						...sseOptions,
						eventSourceInit: reconnectingEventSourceOptions,
					})

					transport.onerror = async (error) => {
						console.error(`Transport error for "${name}":`, error)
						const connection = this.findConnection(name, source)
						if (connection) {
							connection.server.status = "disconnected"
							this.appendErrorMessage(connection, error instanceof Error ? error.message : `${error}`)
						}
						await this.notifyWebviewOfServerChanges()
					}
					break
				}
				case "streamableHttp": {
					transport = new StreamableHTTPClientTransport(new URL(config.url), {
						requestInit: {
							headers: config.headers,
						},
					})
					transport.onerror = async (error) => {
						console.error(`Transport error for "${name}":`, error)
						const connection = this.findConnection(name, source)
						if (connection) {
							connection.server.status = "disconnected"
							this.appendErrorMessage(connection, error instanceof Error ? error.message : `${error}`)
						}
						await this.notifyWebviewOfServerChanges()
					}
					break
				}
				default:
					throw new Error(`Unknown transport type: ${(config as any).type}`)
			}

			const connection: McpConnection = {
				server: {
					name,
					config: JSON.stringify(config),
					status: "connecting",
					disabled: config.disabled,
				},
				client,
				transport,
			}
			this.connections.push(connection)

			// Connect
			await client.connect(transport)

			connection.server.status = "connected"
			connection.server.error = ""

			// Register notification handler for real-time messages
			//console.log(`[MCP Debug] Setting up notification handlers for server: ${name}`)
			//console.log(`[MCP Debug] Client instance:`, connection.client)
			//console.log(`[MCP Debug] Transport type:`, config.type)

			// Try to set notification handler using the client's method
			try {
				// Import the notification schema from MCP SDK
				const { z } = await import("zod")

				// Define the notification schema for notifications/message
				const NotificationMessageSchema = z.object({
					method: z.literal("notifications/message"),
					params: z
						.object({
							level: z.enum(["debug", "info", "warning", "error"]).optional(),
							logger: z.string().optional(),
							data: z.string().optional(),
							message: z.string().optional(),
						})
						.optional(),
				})

				// Set the notification handler
				connection.client.setNotificationHandler(NotificationMessageSchema as any, async (notification: any) => {
					//console.log(`[MCP Notification] ${name}:`, JSON.stringify(notification, null, 2))

					const params = notification.params || {}
					const level = params.level || "info"
					const data = params.data || params.message || ""
					const logger = params.logger || ""

					//console.log(`[MCP Message Notification] ${name}: level=${level}, data=${data}, logger=${logger}`)

					// Format the message
					const message = logger ? `[${logger}] ${data}` : data

					// Send notification directly to active task if callback is set
					if (this.notificationCallback) {
						//console.log(`[MCP Debug] Sending notification to active task: ${message}`)
						this.notificationCallback(name, level, message)
					} else {
						// Fallback: store for later retrieval
						//console.log(`[MCP Debug] No active task, storing notification: ${message}`)
						this.pendingNotifications.push({
							serverName: name,
							level,
							message,
							timestamp: Date.now(),
						})
					}
				})
				//console.log(`[MCP Debug] Successfully set notifications/message handler for ${name}`)

				// Also set a fallback handler for any other notification types
				connection.client.fallbackNotificationHandler = async (notification: any) => {
					//console.log(`[MCP Fallback Notification] ${name}:`, JSON.stringify(notification, null, 2))

					// Show in VS Code for visibility
					HostProvider.window.showMessage({
						type: ShowMessageType.INFORMATION,
						message: `MCP ${name}: ${notification.method || "unknown"} - ${JSON.stringify(notification.params || {})}`,
					})
				}
				//console.log(`[MCP Debug] Successfully set fallback notification handler for ${name}`)
			} catch (error) {
				console.error(`[MCP Debug] Error setting notification handlers for ${name}:`, error)
			}

			// Initial fetch of tools and resources
			connection.server.tools = await this.fetchToolsList(name)
			connection.server.resources = await this.fetchResourcesList(name)
			connection.server.resourceTemplates = await this.fetchResourceTemplatesList(name)
		} catch (error) {
			// Update status with error
			const connection = this.findConnection(name, source)
			if (connection) {
				connection.server.status = "disconnected"
				this.appendErrorMessage(connection, error instanceof Error ? error.message : String(error))
			}
			throw error
		}
	}

	/** 累加错误信息（保持已有信息） */
	private appendErrorMessage(connection: McpConnection, error: string) {
		const newError = connection.server.error ? `${connection.server.error}\n${error}` : error
		connection.server.error = newError //.slice(0, 800)
	}

	/** 拉取工具列表并套用 autoApprove 标记 */
	private async fetchToolsList(serverName: string): Promise<McpTool[]> {
		try {
			const connection = this.connections.find((conn) => conn.server.name === serverName)

			if (!connection) {
				throw new Error(`No connection found for server: ${serverName}`)
			}

			// Disabled servers don't have clients, so return empty tools list
			if (connection.server.disabled || !connection.client) {
				return []
			}

			const response = await connection.client.request({ method: "tools/list" }, ListToolsResultSchema, {
				timeout: DEFAULT_REQUEST_TIMEOUT_MS,
			})

			// Get autoApprove settings
			const settingsPath = await this.getMcpSettingsFilePath()
			const content = await fs.readFile(settingsPath, "utf-8")
			const config = JSON.parse(content)
			const autoApproveConfig = config.mcpServers[serverName]?.autoApprove || []

			// Mark tools as always allowed based on settings
			const tools = (response?.tools || []).map((tool) => ({
				...tool,
				autoApprove: autoApproveConfig.includes(tool.name),
			}))

			return tools
		} catch (error) {
			console.error(`Failed to fetch tools for ${serverName}:`, error)
			return []
		}
	}

	/** 拉取资源列表 */
	private async fetchResourcesList(serverName: string): Promise<McpResource[]> {
		try {
			const connection = this.connections.find((conn) => conn.server.name === serverName)

			// Disabled servers don't have clients, so return empty resources list
			if (!connection || connection.server.disabled || !connection.client) {
				return []
			}

			const response = await connection.client.request({ method: "resources/list" }, ListResourcesResultSchema, {
				timeout: DEFAULT_REQUEST_TIMEOUT_MS,
			})
			return response?.resources || []
		} catch (error) {
			// console.error(`Failed to fetch resources for ${serverName}:`, error)
			return []
		}
	}

	/** 拉取资源模板列表 */
	private async fetchResourceTemplatesList(serverName: string): Promise<McpResourceTemplate[]> {
		try {
			const connection = this.connections.find((conn) => conn.server.name === serverName)

			// Disabled servers don't have clients, so return empty resource templates list
			if (!connection || connection.server.disabled || !connection.client) {
				return []
			}

			const response = await connection.client.request(
				{ method: "resources/templates/list" },
				ListResourceTemplatesResultSchema,
				{
					timeout: DEFAULT_REQUEST_TIMEOUT_MS,
				},
			)

			return response?.resourceTemplates || []
		} catch (error) {
			// console.error(`Failed to fetch resource templates for ${serverName}:`, error)
			return []
		}
	}

	/** 删除连接（关闭传输与客户端） */
	async deleteConnection(name: string): Promise<void> {
		const connection = this.connections.find((conn) => conn.server.name === name)
		if (connection) {
			try {
				// Only close transport and client if they exist (disabled servers don't have them)
				if (connection.transport) {
					await connection.transport.close()
				}
				if (connection.client) {
					await connection.client.close()
				}
			} catch (error) {
				console.error(`Failed to close transport for ${name}:`, error)
			}
			this.connections = this.connections.filter((conn) => conn.server.name !== name)
		}
	}

	/** 根据新配置增删改连接（RPC 触发，不主动通知 webview） */
	async updateServerConnectionsRPC(newServers: Record<string, McpServerConfig>): Promise<void> {
		this.isConnecting = true
		this.removeAllFileWatchers()
		const currentNames = new Set(this.connections.map((conn) => conn.server.name))
		const newNames = new Set(Object.keys(newServers))

		// Delete removed servers
		for (const name of currentNames) {
			if (!newNames.has(name)) {
				await this.deleteConnection(name)
				console.log(`Deleted MCP server: ${name}`)
			}
		}

		// Update or add servers
		for (const [name, config] of Object.entries(newServers)) {
			const currentConnection = this.connections.find((conn) => conn.server.name === name)

			if (!currentConnection) {
				// New server
				try {
					if (config.type === "stdio") {
						this.setupFileWatcher(name, config)
					}
					await this.connectToServer(name, config, "rpc")
				} catch (error) {
					console.error(`Failed to connect to new MCP server ${name}:`, error)
				}
			} else if (!deepEqual(JSON.parse(currentConnection.server.config), config)) {
				// Existing server with changed config
				try {
					if (config.type === "stdio") {
						this.setupFileWatcher(name, config)
					}
					await this.deleteConnection(name)
					await this.connectToServer(name, config, "rpc")
					console.log(`Reconnected MCP server with updated config: ${name}`)
				} catch (error) {
					console.error(`Failed to reconnect MCP server ${name}:`, error)
				}
			}
			// If server exists with same config, do nothing
		}

		this.isConnecting = false
	}

	/** 根据新配置增删改连接（内部触发，结束时通知 webview） */
	async updateServerConnections(newServers: Record<string, McpServerConfig>): Promise<void> {
		this.isConnecting = true
		this.removeAllFileWatchers()
		const currentNames = new Set(this.connections.map((conn) => conn.server.name))
		const newNames = new Set(Object.keys(newServers))

		// Delete removed servers
		for (const name of currentNames) {
			if (!newNames.has(name)) {
				await this.deleteConnection(name)
				console.log(`Deleted MCP server: ${name}`)
			}
		}

		// Update or add servers
		for (const [name, config] of Object.entries(newServers)) {
			const currentConnection = this.connections.find((conn) => conn.server.name === name)

			if (!currentConnection) {
				// New server
				try {
					if (config.type === "stdio") {
						this.setupFileWatcher(name, config)
					}
					await this.connectToServer(name, config, "internal")
				} catch (error) {
					console.error(`Failed to connect to new MCP server ${name}:`, error)
				}
			} else if (!deepEqual(JSON.parse(currentConnection.server.config), config)) {
				// Existing server with changed config
				try {
					if (config.type === "stdio") {
						this.setupFileWatcher(name, config)
					}
					await this.deleteConnection(name)
					await this.connectToServer(name, config, "internal")
					console.log(`Reconnected MCP server with updated config: ${name}`)
				} catch (error) {
					console.error(`Failed to reconnect MCP server ${name}:`, error)
				}
			}
			// If server exists with same config, do nothing
		}
		await this.notifyWebviewOfServerChanges()
		this.isConnecting = false
	}

	/** 针对 stdio 构建产物设定文件变更监听，自动重启 */
	private setupFileWatcher(name: string, config: Extract<McpServerConfig, { type: "stdio" }>) {
		const filePath = config.args?.find((arg: string) => arg.includes("build/index.js"))
		if (filePath) {
			// we use chokidar instead of onDidSaveTextDocument because it doesn't require the file to be open in the editor. The settings config is better suited for onDidSave since that will be manually updated by the user or Cline (and we want to detect save events, not every file change)
			const watcher = chokidar.watch(filePath, {
				// persistent: true,
				// ignoreInitial: true,
				// awaitWriteFinish: true, // This helps with atomic writes
			})

			watcher.on("change", () => {
				console.log(`Detected change in ${filePath}. Restarting server ${name}...`)
				this.restartConnection(name)
			})

			this.fileWatchers.set(name, watcher)
		}
	}

	/** 移除全部文件监听器 */
	private removeAllFileWatchers() {
		this.fileWatchers.forEach((watcher) => watcher.close())
		this.fileWatchers.clear()
	}

	/** RPC 触发的重启：返回最新服务器列表 */
	async restartConnectionRPC(serverName: string): Promise<McpServer[]> {
		this.isConnecting = true

		// Get existing connection and update its status
		const connection = this.connections.find((conn) => conn.server.name === serverName)
		const inMemoryConfig = connection?.server.config
		if (inMemoryConfig) {
			connection.server.status = "connecting"
			connection.server.error = ""
			await setTimeoutPromise(500) // artificial delay to show user that server is restarting
			try {
				await this.deleteConnection(serverName)
				// Try to connect again using existing config
				await this.connectToServer(serverName, JSON.parse(inMemoryConfig), "rpc")
			} catch (error) {
				console.error(`Failed to restart connection for ${serverName}:`, error)
			}
		}

		this.isConnecting = false

		const config = await this.readAndValidateMcpSettingsFile()
		if (!config) {
			throw new Error("Failed to read or validate MCP settings")
		}

		const serverOrder = Object.keys(config.mcpServers || {})
		return this.getSortedMcpServers(serverOrder)
	}

	/** 内部重启：用于文件改动触发或 UI 操作 */
	async restartConnection(serverName: string): Promise<void> {
		this.isConnecting = true

		// Get existing connection and update its status
		const connection = this.connections.find((conn) => conn.server.name === serverName)
		const config = connection?.server.config
		if (config) {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: `Restarting ${serverName} MCP server...`,
			})
			connection.server.status = "connecting"
			connection.server.error = ""
			await this.notifyWebviewOfServerChanges()
			await setTimeoutPromise(500) // artificial delay to show user that server is restarting
			try {
				await this.deleteConnection(serverName)
				// Try to connect again using existing config
				await this.connectToServer(serverName, JSON.parse(config), "internal")
				HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message: `${serverName} MCP server connected`,
				})
			} catch (error) {
				console.error(`Failed to restart connection for ${serverName}:`, error)
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: `Failed to connect to ${serverName} MCP server`,
				})
			}
		}

		await this.notifyWebviewOfServerChanges()
		this.isConnecting = false
	}

	/**
	 * Gets sorted MCP servers based on the order defined in settings
	 * @param serverOrder Array of server names in the order they appear in settings
	 * @returns Array of McpServer objects sorted according to settings order
	 */
	/** 按配置文件出现顺序排序服务器 */
	private getSortedMcpServers(serverOrder: string[]): McpServer[] {
		return [...this.connections]
			.sort((a, b) => {
				const indexA = serverOrder.indexOf(a.server.name)
				const indexB = serverOrder.indexOf(b.server.name)
				return indexA - indexB
			})
			.map((connection) => connection.server)
	}

	/** 通过 gRPC 推送最新服务器列表到前端 */
	private async notifyWebviewOfServerChanges(): Promise<void> {
		// servers should always be sorted in the order they are defined in the settings file
		const settingsPath = await this.getMcpSettingsFilePath()
		const content = await fs.readFile(settingsPath, "utf-8")
		const config = JSON.parse(content)
		const serverOrder = Object.keys(config.mcpServers || {})

		// Get sorted servers
		const sortedServers = this.getSortedMcpServers(serverOrder)

		// Send update using gRPC stream
		await sendMcpServersUpdate({
			mcpServers: convertMcpServersToProtoMcpServers(sortedServers),
		})
	}

	/** 主动发送最新服务器列表 */
	async sendLatestMcpServers() {
		await this.notifyWebviewOfServerChanges()
	}

	/** RPC 获取（不触发推送）当前排序后的服务器列表 */
	async getLatestMcpServersRPC(): Promise<McpServer[]> {
		const settings = await this.readAndValidateMcpSettingsFile()
		if (!settings) {
			// Return empty array if settings can't be read or validated
			return []
		}

		const serverOrder = Object.keys(settings.mcpServers || {})
		return this.getSortedMcpServers(serverOrder)
	}

	// Using server

	// Public methods for server management

	/** 启用/禁用服务器（RPC 版本，返回最新列表） */
	public async toggleServerDisabledRPC(serverName: string, disabled: boolean): Promise<McpServer[]> {
		try {
			const config = await this.readAndValidateMcpSettingsFile()
			if (!config) {
				throw new Error("Failed to read or validate MCP settings")
			}

			if (config.mcpServers[serverName]) {
				config.mcpServers[serverName].disabled = disabled

				const settingsPath = await this.getMcpSettingsFilePath()
				await fs.writeFile(settingsPath, JSON.stringify(config, null, 2))

				const connection = this.connections.find((conn) => conn.server.name === serverName)
				if (connection) {
					connection.server.disabled = disabled
				}

				const serverOrder = Object.keys(config.mcpServers || {})
				return this.getSortedMcpServers(serverOrder)
			}
			console.error(`Server "${serverName}" not found in MCP configuration`)
			throw new Error(`Server "${serverName}" not found in MCP configuration`)
		} catch (error) {
			console.error("Failed to update server disabled state:", error)
			if (error instanceof Error) {
				console.error("Error details:", error.message, error.stack)
			}
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: `Failed to update server state: ${error instanceof Error ? error.message : String(error)}`,
			})
			throw error
		}
	}

	async readResource(serverName: string, uri: string): Promise<McpResourceResponse> {
		const connection = this.connections.find((conn) => conn.server.name === serverName)
		if (!connection) {
			throw new Error(`No connection found for server: ${serverName}`)
		}
		if (connection.server.disabled) {
			throw new Error(`Server "${serverName}" is disabled`)
		}

		return await connection.client.request(
			{
				method: "resources/read",
				params: {
					uri,
				},
			},
			ReadResourceResultSchema,
		)
	}

	async callTool(serverName: string, toolName: string, toolArguments?: Record<string, unknown>): Promise<McpToolCallResponse> {
		const connection = this.connections.find((conn) => conn.server.name === serverName)
		if (!connection) {
			throw new Error(
				`No connection found for server: ${serverName}. Please make sure to use MCP servers available under 'Connected MCP Servers'.`,
			)
		}

		if (connection.server.disabled) {
			throw new Error(`Server "${serverName}" is disabled and cannot be used`)
		}

		let timeout = secondsToMs(DEFAULT_MCP_TIMEOUT_SECONDS) // sdk expects ms

		try {
			const config = JSON.parse(connection.server.config)
			const parsedConfig = ServerConfigSchema.parse(config)
			timeout = secondsToMs(parsedConfig.timeout)
		} catch (error) {
			console.error(`Failed to parse timeout configuration for server ${serverName}: ${error}`)
		}

		const result = await connection.client.request(
			{
				method: "tools/call",
				params: {
					name: toolName,
					arguments: toolArguments,
				},
			},
			CallToolResultSchema,
			{
				timeout,
			},
		)

		return {
			...result,
			content: result.content ?? [],
		}
	}

	/**
	 * RPC variant of toggleToolAutoApprove that returns the updated servers instead of notifying the webview
	 * @param serverName The name of the MCP server
	 * @param toolNames Array of tool names to toggle auto-approve for
	 * @param shouldAllow Whether to enable or disable auto-approve
	 * @returns Array of updated MCP servers
	 */
	async toggleToolAutoApproveRPC(serverName: string, toolNames: string[], shouldAllow: boolean): Promise<McpServer[]> {
		try {
			const settingsPath = await this.getMcpSettingsFilePath()
			const content = await fs.readFile(settingsPath, "utf-8")
			const config = JSON.parse(content)

			// Initialize autoApprove if it doesn't exist
			if (!config.mcpServers[serverName].autoApprove) {
				config.mcpServers[serverName].autoApprove = []
			}

			const autoApprove = config.mcpServers[serverName].autoApprove
			for (const toolName of toolNames) {
				const toolIndex = autoApprove.indexOf(toolName)

				if (shouldAllow && toolIndex === -1) {
					// Add tool to autoApprove list
					autoApprove.push(toolName)
				} else if (!shouldAllow && toolIndex !== -1) {
					// Remove tool from autoApprove list
					autoApprove.splice(toolIndex, 1)
				}
			}

			await fs.writeFile(settingsPath, JSON.stringify(config, null, 2))

			// Update the tools list to reflect the change
			const connection = this.connections.find((conn) => conn.server.name === serverName)
			if (connection && connection.server.tools) {
				// Update the autoApprove property of each tool in the in-memory server object
				/*`...tool` 是 JavaScript/TypeScript 中对象展开运算符（Spread Operator）__：
			- __作用__：将 `tool` 对象的所有可枚举属性展开并复制到新对象中
			- __结果__：创建一个新对象，包含 `tool` 的所有原有属性，然后可以添加新属性或覆盖现有属性
				*/
				connection.server.tools = connection.server.tools.map((tool) => ({
					...tool,
					autoApprove: autoApprove.includes(tool.name),
				}))
			}

			// Return sorted servers without notifying webview
			const serverOrder = Object.keys(config.mcpServers || {})
			return this.getSortedMcpServers(serverOrder)
		} catch (error) {
			console.error("Failed to update autoApprove settings:", error)
			throw error // Re-throw to ensure the error is properly handled
		}
	}

	async toggleToolAutoApprove(serverName: string, toolNames: string[], shouldAllow: boolean): Promise<void> {
		try {
			const settingsPath = await this.getMcpSettingsFilePath()
			const content = await fs.readFile(settingsPath, "utf-8")
			const config = JSON.parse(content)

			// Initialize autoApprove if it doesn't exist
			if (!config.mcpServers[serverName].autoApprove) {
				config.mcpServers[serverName].autoApprove = []
			}

			const autoApprove = config.mcpServers[serverName].autoApprove
			for (const toolName of toolNames) {
				const toolIndex = autoApprove.indexOf(toolName)

				if (shouldAllow && toolIndex === -1) {
					// Add tool to autoApprove list 如果没有找到该元素，返回-1
					autoApprove.push(toolName)
				} else if (!shouldAllow && toolIndex !== -1) {
					// Remove tool from autoApprove list
					autoApprove.splice(toolIndex, 1)
				}
			}

			await fs.writeFile(settingsPath, JSON.stringify(config, null, 2))

			// Update the tools list to reflect the change
			const connection = this.connections.find((conn) => conn.server.name === serverName)
			if (connection && connection.server.tools) {
				// Update the autoApprove property of each tool in the in-memory server object
				connection.server.tools = connection.server.tools.map((tool) => ({
					...tool,
					autoApprove: autoApprove.includes(tool.name),
				}))
				await this.notifyWebviewOfServerChanges()
			}
		} catch (error) {
			console.error("Failed to update autoApprove settings:", error)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Failed to update autoApprove settings",
			})
			throw error // Re-throw to ensure the error is properly handled
		}
	}

	public async addRemoteServer(serverName: string, serverUrl: string): Promise<McpServer[]> {
		try {
			const settings = await this.readAndValidateMcpSettingsFile()
			if (!settings) {
				throw new Error("Failed to read MCP settings")
			}

			if (settings.mcpServers[serverName]) {
				throw new Error(`An MCP server with the name "${serverName}" already exists`)
			}

			const urlValidation = z.string().url().safeParse(serverUrl)
			if (!urlValidation.success) {
				throw new Error(`Invalid server URL: ${serverUrl}. Please provide a valid URL.`)
			}

			const serverConfig = {
				url: serverUrl,
				disabled: false,
				autoApprove: [],
			}

			const parsedConfig = ServerConfigSchema.parse(serverConfig)

			settings.mcpServers[serverName] = parsedConfig
			const settingsPath = await this.getMcpSettingsFilePath()

			// We don't write the zod-transformed version to the file.
			// The above parse() call adds the transportType field to the server config
			// It would be fine if this was written, but we don't want to clutter up the file with internal details

			// ToDo: We could benefit from input / output types reflecting the non-transformed / transformed versions
			await fs.writeFile(
				settingsPath,
				JSON.stringify({ mcpServers: { ...settings.mcpServers, [serverName]: serverConfig } }, null, 2),
			)

			await this.updateServerConnectionsRPC(settings.mcpServers)

			const serverOrder = Object.keys(settings.mcpServers || {})
			return this.getSortedMcpServers(serverOrder)
		} catch (error) {
			console.error("Failed to add remote MCP server:", error)
			throw error
		}
	}

	/**
	 * RPC variant of deleteServer that returns the updated server list directly
	 * @param serverName The name of the server to delete
	 * @returns Array of remaining MCP servers
	 */
	public async deleteServerRPC(serverName: string): Promise<McpServer[]> {
		try {
			const settingsPath = await this.getMcpSettingsFilePath()
			const content = await fs.readFile(settingsPath, "utf-8")
			const config = JSON.parse(content)
			if (!config.mcpServers || typeof config.mcpServers !== "object") {
				config.mcpServers = {}
			}

			if (config.mcpServers[serverName]) {
				delete config.mcpServers[serverName]
				const updatedConfig = {
					mcpServers: config.mcpServers,
				}
				await fs.writeFile(settingsPath, JSON.stringify(updatedConfig, null, 2))
				await this.updateServerConnectionsRPC(config.mcpServers)

				// Get the servers in their correct order from settings
				const serverOrder = Object.keys(config.mcpServers || {})
				return this.getSortedMcpServers(serverOrder)
			} else {
				throw new Error(`${serverName} not found in MCP configuration`)
			}
		} catch (error) {
			console.error(`Failed to delete MCP server: ${error instanceof Error ? error.message : String(error)}`)
			throw error
		}
	}

	public async updateServerTimeoutRPC(serverName: string, timeout: number): Promise<McpServer[]> {
		try {
			// Validate timeout against schema
			const setConfigResult = BaseConfigSchema.shape.timeout.safeParse(timeout)
			if (!setConfigResult.success) {
				throw new Error(`Invalid timeout value: ${timeout}. Must be at minimum ${MIN_MCP_TIMEOUT_SECONDS} seconds.`)
			}

			const settingsPath = await this.getMcpSettingsFilePath()
			const content = await fs.readFile(settingsPath, "utf-8")
			const config = JSON.parse(content)

			if (!config.mcpServers?.[serverName]) {
				throw new Error(`Server "${serverName}" not found in settings`)
			}

			config.mcpServers[serverName] = {
				...config.mcpServers[serverName],
				timeout,
			}

			await fs.writeFile(settingsPath, JSON.stringify(config, null, 2))

			await this.updateServerConnectionsRPC(config.mcpServers)

			const serverOrder = Object.keys(config.mcpServers || {})
			return this.getSortedMcpServers(serverOrder)
		} catch (error) {
			console.error("Failed to update server timeout:", error)
			if (error instanceof Error) {
				console.error("Error details:", error.message, error.stack)
			}
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: `Failed to update server timeout: ${error instanceof Error ? error.message : String(error)}`,
			})
			throw error
		}
	}

	/**
	 * Get and clear pending notifications
	 * @returns Array of pending notifications
	 */
	getPendingNotifications(): Array<{
		serverName: string
		level: string
		message: string
		timestamp: number
	}> {
		const notifications = [...this.pendingNotifications]
		this.pendingNotifications = []
		return notifications
	}

	/**
	 * Set the notification callback for real-time notifications
	 * @param callback Function to call when notifications arrive
	 */
	setNotificationCallback(callback: (serverName: string, level: string, message: string) => void): void {
		this.notificationCallback = callback
		//console.log("[MCP Debug] Notification callback set")
	}

	/**
	 * Clear the notification callback
	 */
	clearNotificationCallback(): void {
		this.notificationCallback = undefined
		//console.log("[MCP Debug] Notification callback cleared")
	}

	async dispose(): Promise<void> {
		this.removeAllFileWatchers()
		for (const connection of this.connections) {
			try {
				await this.deleteConnection(connection.server.name)
			} catch (error) {
				console.error(`Failed to close connection for ${connection.server.name}:`, error)
			}
		}
		this.connections = []
		if (this.settingsWatcher) {
			this.settingsWatcher.dispose()
		}
		this.disposables.forEach((d) => d.dispose())
	}

	/**
	 * 使用原生VS Code FileSystemWatcher监听MCP设置文件的变化
	 * 此方法与原有的watchMcpSettingsFile功能相同，但使用VS Code原生API
	 * 可以替代基于gRPC的文件监听实现
	 */
	private async watchMcpSettingsFileWithNativeWatcher(): Promise<void> {
		const settingsPath = await this.getMcpSettingsFilePath()
		
		// 创建VS Code原生的文件系统监听器
		// 监听指定路径的文件变化（创建、修改、删除）
		this.settingsWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(
				vscode.Uri.file(path.dirname(settingsPath)),
				path.basename(settingsPath)
			),
			false, // 不忽略创建事件
			false, // 不忽略修改事件  
			false  // 不忽略删除事件
		)

		// 监听文件修改事件 - 这是最主要的事件
		// 当用户或程序修改cline_mcp_settings.json时触发
		this.settingsWatcher.onDidChange(async (uri: vscode.Uri) => {
			console.log(`[Native Watcher] MCP settings file changed: ${uri.fsPath}`)
			
			try {
				// 读取并验证配置文件内容
				const settings = await this.readAndValidateMcpSettingsFile()
				if (settings) {
					// 更新服务器连接配置，这里使用internal模式
					// 因为这是由文件变化自动触发的，不是RPC调用
					await this.updateServerConnections(settings.mcpServers)
					console.log(`[Native Watcher] Successfully updated MCP server connections`)
				} else {
					console.warn(`[Native Watcher] Failed to read or validate MCP settings after change`)
				}
			} catch (error) {
				console.error(`[Native Watcher] Error processing MCP settings change:`, error)
				// 显示错误消息给用户
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: `Failed to process MCP settings change: ${error instanceof Error ? error.message : String(error)}`,
				})
			}
		})

		// 监听文件创建事件
		// 当首次创建cline_mcp_settings.json时触发
		this.settingsWatcher.onDidCreate(async (uri: vscode.Uri) => {
			console.log(`[Native Watcher] MCP settings file created: ${uri.fsPath}`)
			
			try {
				// 文件刚创建时，读取初始配置
				const settings = await this.readAndValidateMcpSettingsFile()
				if (settings) {
					await this.updateServerConnections(settings.mcpServers)
					console.log(`[Native Watcher] Successfully loaded initial MCP server connections`)
				}
			} catch (error) {
				console.error(`[Native Watcher] Error processing MCP settings creation:`, error)
			}
		})

		// 监听文件删除事件
		// 当cline_mcp_settings.json被删除时触发
		this.settingsWatcher.onDidDelete(async (uri: vscode.Uri) => {
			console.log(`[Native Watcher] MCP settings file deleted: ${uri.fsPath}`)
			
			try {
				// 文件被删除时，断开所有服务器连接
				// 传递空配置对象，这会导致所有连接被清理
				await this.updateServerConnections({})
				console.log(`[Native Watcher] Disconnected all MCP servers due to settings file deletion`)
				
			} catch (error) {
				console.error(`[Native Watcher] Error processing MCP settings deletion:`, error)
			}
		})

		// 将文件监听器添加到disposables数组，确保在清理时正确释放资源
		this.disposables.push(this.settingsWatcher)

		console.log(`[Native Watcher] Started watching MCP settings file: ${settingsPath}`)
	}

	/**
	 * 切换到原生文件监听器的便捷方法
	 * 调用此方法可以将当前的gRPC文件监听切换为VS Code原生文件监听
	 * 注意：调用此方法前应确保已经停止了gRPC监听
	 */
	public async switchToNativeFileWatcher(): Promise<void> {
		try {
			// 如果已经有settingsWatcher，先清理它
			if (this.settingsWatcher) {
				this.settingsWatcher.dispose()
				this.settingsWatcher = undefined
			}

			// 启动原生文件监听器
			await this.watchMcpSettingsFileWithNativeWatcher()
			
			console.log(`[Native Watcher] Successfully switched to native file watcher`)
			
			// 可选：显示成功消息
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: `Switched to native VS Code file watcher for MCP settings monitoring.`,
			})
		} catch (error) {
			console.error(`[Native Watcher] Failed to switch to native file watcher:`, error)
			throw error
		}
	}

	/**
	 * 获取当前使用的文件监听器类型
	 * @returns 'native' 如果使用VS Code原生监听器，'grpc' 如果使用gRPC监听器，'none' 如果都没有
	 */
	public getFileWatcherType(): 'native' | 'grpc' | 'none' {
		if (this.settingsWatcher) {
			return 'native'
		}
		
		// 检查disposables中是否有gRPC订阅
		// gRPC订阅通过disposables管理，但没有直接的属性引用
		const hasGrpcSubscription = this.disposables.some(d => 
			d && typeof d.dispose === 'function' && d !== this.settingsWatcher
		)
		
		if (hasGrpcSubscription) {
			return 'grpc'
		}
		
		return 'none'
	}
}
