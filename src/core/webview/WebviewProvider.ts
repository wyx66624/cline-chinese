import axios from "axios"
// 若项目未显式引入 @types/node，这里声明必要的 Node 全局以避免类型报错。
// （如果后续在 tsconfig 中添加 "types": ["node"] 可移除下方声明。）
// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare const __dirname: string
// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare const process: { env: Record<string, string | undefined> }
import * as vscode from "vscode"
import { getNonce } from "./getNonce"

import { WebviewProviderType } from "@/shared/webview/types"
import { Controller } from "@core/controller/index"
import { findLast } from "@shared/array"
import { readFile } from "fs/promises"
import path from "node:path"
import { v4 as uuidv4 } from "uuid"
import { Uri } from "vscode"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"

/**
 * WebviewProvider 抽象基类
 *
 * 职责：
 * 1. 维护所有 WebviewProvider 实例（静态集合），提供查找/过滤能力
 * 2. 封装与 webview 静态资源、HMR 开发调试、CSP 安全策略相关的公共逻辑
 * 3. 维护每个 webview 对应的控制器 Controller（业务会话/消息桥梁）
 * 4. 生成并注入 clientId 以便前后端(扩展 <-> webview) 进行区分和路由
 * 5. 提供抽象方法，让不同类型（侧边栏 / Tab 等）的具体实现自定义可见性、活动状态、URI 转换与 CSP 计算逻辑
 *
 * 线程 / 生命周期说明：
 * - VS Code 扩展运行在单线程事件循环中；本类方法内部若有异步操作（如读取文件、HTTP 检测 dev server）会使用 Promise。
 * - dispose() 需被调用以释放 Controller 与静态集合引用，防止内存泄漏。
 */
export abstract class WebviewProvider {
	/**
	 * 当前所有未释放的 WebviewProvider 实例集合。
	 * 用 Set 而不是数组：避免重复；移除 O(1)。
	 */
	private static activeInstances: Set<WebviewProvider> = new Set()

	/**
	 * 实例 -> clientId 映射表，便于通过实例检索对应的唯一客户端 id。
	 * 与 activeInstances 分离，减少对象属性暴露，同时支持快速查询。
	 */
	private static clientIdMap = new Map<WebviewProvider, string>()

	/**
	 * 业务控制器，承载该 webview 与后台核心逻辑之间的通信、状态与缓存。
	 * 在构造函数中根据 clientId 创建；需随实例销毁而 dispose。
	 */
	controller: Controller

	/**
	 * 唯一客户端 ID（UUID v4）。注入到 webview (window.clineChineseClientId) 以便前端发消息 / 标识。
	 */
	private clientId: string

	/**
	 * 最近一次被标记为“活动（active）”的 Controller ID。
	 * - 可能为 null（初始或全部销毁时）
	 * - 用于在多实例环境下快速恢复/定位上一次使用的实例
	 */
	private static lastActiveControllerId: string | null = null

	/**
	 * 构造函数
	 * @param context VS Code 扩展上下文 (ExtensionContext)
	 * @param providerType Provider 类型（SIDEBAR / TAB 等）用于区分 UI 呈现形态
	 */
	constructor(
		readonly context: vscode.ExtensionContext,
		private readonly providerType: WebviewProviderType,
	) {
		// 将当前实例加入活跃集合，供全局静态检索
		WebviewProvider.activeInstances.add(this)
		// 生成唯一 clientId 并记录
		this.clientId = uuidv4()
		WebviewProvider.clientIdMap.set(this, this.clientId)

		// 创建业务控制器（含缓存服务等）。传入 clientId 便于区分多 webview 会话。
		this.controller = new Controller(context, this.clientId)
		// 标记最近活动 controller id，便于后续恢复
		WebviewProvider.setLastActiveControllerId(this.controller.id)
	}

	/**
	 * 获取当前实例的 clientId。
	 * @returns 唯一客户端 ID
	 */
	public getClientId(): string {
		return this.clientId
	}

	/**
	 * 通过实例获取其 clientId（静态方法，便于无需暴露实例内部属性）。
	 * @param instance 目标 WebviewProvider 实例
	 * @returns 该实例对应的 clientId；若不存在（已释放）返回 undefined
	 */
	public static getClientIdForInstance(instance: WebviewProvider): string | undefined {
		return WebviewProvider.clientIdMap.get(instance)
	}

	/**
	 * 释放当前实例资源：
	 * 1. 调用 controller.dispose()（释放底层监听 / 缓存）
	 * 2. 从 activeInstances 集合移除
	 * 3. 从 clientIdMap 移除
	 */
	async dispose() {
		await this.controller.dispose()
		WebviewProvider.activeInstances.delete(this)
		WebviewProvider.clientIdMap.delete(this)
	}

	/**
	 * 获取“最后一个仍然可见”的实例。
	 * 策略：从 activeInstances 转为数组后倒序逻辑（借助 findLast）找出 isVisible() === true 的最后一个。
	 * @returns 可见实例或 undefined
	 */
	public static getVisibleInstance(): WebviewProvider | undefined {
		return findLast(Array.from(WebviewProvider.activeInstances), (instance) => instance.isVisible() === true)
	}

	/**
	 * 获取当前处于“活动”状态的实例（由子类 isActive 判定）。
	 * @returns 活动实例或 undefined
	 */
	public static getActiveInstance(): WebviewProvider | undefined {
		return Array.from(WebviewProvider.activeInstances).find((instance) => instance.isActive())
	}

	/**
	 * 抽象：判断该实例是否“活动”。
	 * - 由具体实现（不同 UI 容器）根据 VSCode API 面板焦点 / 选中状态等判定。
	 */
	protected abstract isActive(): boolean

	/**
	 * 获取所有仍未 dispose 的实例快照数组。
	 */
	public static getAllInstances(): WebviewProvider[] {
		return Array.from(WebviewProvider.activeInstances)
	}

	/**
	 * 获取侧边栏（SIDEBAR 类型）的实例（若多个只取第一个）。
	 */
	public static getSidebarInstance() {
		return Array.from(WebviewProvider.activeInstances).find(
			(instance) => instance.providerType === WebviewProviderType.SIDEBAR,
		)
	}

	/**
	 * 获取所有 Tab 类型实例（可能有多个独立面板）。
	 */
	public static getTabInstances(): WebviewProvider[] {
		return Array.from(WebviewProvider.activeInstances).filter((instance) => instance.providerType === WebviewProviderType.TAB)
	}

	/**
	 * 根据 lastActiveControllerId 返回对应实例。
	 * 若记录不存在则返回 undefined。
	 */
	public static getLastActiveInstance(): WebviewProvider | undefined {
		const lastActiveId = WebviewProvider.getLastActiveControllerId()
		if (!lastActiveId) {
			return undefined
		}
		return Array.from(WebviewProvider.activeInstances).find((instance) => instance.controller.id === lastActiveId)
	}

	/**
	 * 获取最近活动的 Controller ID。
	 * 回退策略：若 lastActiveControllerId 为空，尝试返回侧边栏实例的 controller.id。
	 * @returns controllerId 或 null
	 */
	public static getLastActiveControllerId(): string | null {
		return WebviewProvider.lastActiveControllerId || WebviewProvider.getSidebarInstance()?.controller.id || null
	}

	/**
	 * 设置最近活动的 Controller ID。
	 * 仅当新旧值不同才写入，避免无效更新。
	 * @param controllerId 新的活动 controllerId，可为 null
	 */
	public static setLastActiveControllerId(controllerId: string | null): void {
		if (WebviewProvider.lastActiveControllerId !== controllerId) {
			WebviewProvider.lastActiveControllerId = controllerId
		}
	}

	/**
	 * 批量释放所有实例（常用于停用扩展 / 全局重置）。
	 */
	public static async disposeAllInstances() {
		const instances = Array.from(WebviewProvider.activeInstances)
		for (const instance of instances) {
			await instance.dispose()
		}
	}

	/**
	 * 抽象：将本地扩展资源 Uri 转换为 webview 可访问的安全 Uri。
	 * - VS Code 需通过 webview.asWebviewUri() 之类的 API 做协议映射
	 * @param uri 原始扩展文件 Uri
	 */
	abstract getWebviewUri(uri: Uri): Uri

	/**
	 * 抽象：返回当前 webview CSP 源（通常来自 webview.cspSource）。
	 * 供本类组装 meta Content-Security-Policy 使用。
	 */
	abstract getCspSource(): string

	/**
	 * 抽象：判断该 webview 是否在界面中“可见”（与 isActive 区别：可见不一定聚焦）。
	 */
	abstract isVisible(): boolean

	/**
	 * 生产 / 打包模式下生成最终 HTML 字符串。
	 * - 引用构建产物 index.css / index.js
	 * - 注入 codicons 字体
	 * - 注入 clientId 与 providerType
	 * - 设置 CSP，限制资源加载范围，提升安全
	 * @returns 完整 HTML 文本
	 */
	public getHtmlContent(): string {
		// React 打包产物 CSS 资源 URI
		const stylesUri = this.getExtensionUri("webview-ui", "build", "assets", "index.css")
		// React 打包产物 JS 资源 URI
		const scriptUri = this.getExtensionUri("webview-ui", "build", "assets", "index.js")
		// VS Code codicon 字体样式 URI（供 icon 使用）
		const codiconsUri = this.getExtensionUri("node_modules", "@vscode", "codicons", "dist", "codicon.css")

		// 生成 nonce，用于 CSP 中限制允许执行的 <script>
		const nonce = getNonce()

		return /*html*/ `
			<!DOCTYPE html>
			<html lang="en">
				<head>
				<meta charset="utf-8">
				<meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
				<meta name="theme-color" content="#000000">
				<link rel="stylesheet" type="text/css" href="${stylesUri}">
				<link href="${codiconsUri}" rel="stylesheet" />
				<meta http-equiv="Content-Security-Policy" content="default-src 'none';
					connect-src https://*.shengsuanyun.com https://*.posthog.com https://*.cline.bot https://*.firebaseauth.com https://*.firebaseio.com https://*.googleapis.com https://*.firebase.com; 
					font-src ${this.getCspSource()} data:; 
					style-src ${this.getCspSource()} 'unsafe-inline'; 
					img-src ${this.getCspSource()} https: data:; 
					script-src 'nonce-${nonce}' 'unsafe-eval';">
				<title>Cline Chinese</title>
			</head>
			<body>
				<noscript>You need to enable JavaScript to run this app.</noscript>
				<div id="root"></div>
				 <script type="text/javascript" nonce="${nonce}">
					// 注入 provider 类型到全局，用于前端逻辑分支
					window.WEBVIEW_PROVIDER_TYPE = ${JSON.stringify(this.providerType)};
					// 注入唯一 clientId 供消息通道使用
					window.clineChineseClientId = "${this.clientId}";
				</script>
				<script type="module" nonce="${nonce}" src="${scriptUri}"></script>
				<script src="http://localhost:8097"></script> 
			</body>
		</html>
		`
	}

	/**
	 * 读取本地 Vite dev server 端口（开发 HMR 场景）。
	 * 逻辑：尝试读取生成的 .vite-port 文件；失败则回退默认端口。
	 * @returns Promise<number> 最终使用的端口号
	 */
	private getDevServerPort(): Promise<number> {
		const DEFAULT_PORT = 25463
		const portFilePath = path.join(__dirname, "..", "webview-ui", ".vite-port")

		return readFile(portFilePath, "utf8")
			.then((portFile: string) => {
				const port = parseInt(portFile.trim()) || DEFAULT_PORT
				console.info(`[getDevServerPort] Using dev server port ${port} from .vite-port file`)
				return port
			})
			.catch(() => {
				console.warn(
					`[getDevServerPort] Port file not found or couldn't be read at ${portFilePath}, using default port: ${DEFAULT_PORT}`,
				)
				return DEFAULT_PORT
			})
	}

	/**
	 * 开发模式：尝试连接本地 Vite server 以启用 HMR。
	 * - 若连接失败：退回生产构建 getHtmlContent()
	 * - 成功：注入 React Refresh 预处理脚本与开发 CSP 策略。
	 * @returns HTML 字符串
	 */
	protected async getHMRHtmlContent(): Promise<string> {
		const localPort = await this.getDevServerPort()
		const localServerUrl = `localhost:${localPort}`

		try {
			// 探测本地 dev server 是否可访问
			await axios.get(`http://${localServerUrl}`)
		} catch {
			if (process.env.IS_DEV) {
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message:
						"Cline: Local webview dev server is not running, HMR will not work. Please run 'npm run dev:webview' before launching the extension to enable HMR. Using bundled assets.",
				})
			}
			return this.getHtmlContent()
		}

		const nonce = getNonce()
		const stylesUri = this.getExtensionUri("webview-ui", "build", "assets", "index.css")
		const codiconsUri = this.getExtensionUri("node_modules", "@vscode", "codicons", "dist", "codicon.css")
		const scriptEntrypoint = "src/main.tsx"
		const scriptUri = `http://${localServerUrl}/${scriptEntrypoint}`

		// React Refresh 运行时注入（需在真正入口脚本前执行）
		const reactRefresh = /*html*/ `
			<script nonce="${nonce}" type="module">
				import RefreshRuntime from "http://${localServerUrl}/@react-refresh"
				RefreshRuntime.injectIntoGlobalHook(window)
				window.$RefreshReg$ = () => {}
				window.$RefreshSig$ = () => (type) => type
				window.__vite_plugin_react_preamble_installed__ = true
			</script>
		`

		// 开发场景 CSP：允许连接本地 http / ws 与 unsafe-eval（Vite 需求）
		const csp = [
			"default-src 'none'",
			`font-src ${this.getCspSource()}`,
			`style-src ${this.getCspSource()} 'unsafe-inline' https://* http://${localServerUrl} http://0.0.0.0:${localPort}`,
			`img-src ${this.getCspSource()} https: data:`,
			`script-src 'unsafe-eval' https://* http://${localServerUrl} http://0.0.0.0:${localPort} 'nonce-${nonce}'`,
			`connect-src https://* ws://${localServerUrl} ws://0.0.0.0:${localPort} http://${localServerUrl} http://0.0.0.0:${localPort}`,
		]

		return /*html*/ `
			<!DOCTYPE html>
			<html lang="en">
				<head>
					${process.env.IS_DEV ? '<script src="http://localhost:8097"></script>' : ""}
					<meta charset="utf-8">
					<meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
					<meta http-equiv="Content-Security-Policy" content="${csp.join("; ")}">
					<link rel="stylesheet" type="text/css" href="${stylesUri}">
					<link href="${codiconsUri}" rel="stylesheet" />
					<title>Cline Chinese</title>
				</head>
				<body>
					<div id="root"></div>
					<script type="text/javascript" nonce="${nonce}">
						window.WEBVIEW_PROVIDER_TYPE = ${JSON.stringify(this.providerType)};
						window.clineChineseClientId = "${this.clientId}";
					</script>
					${reactRefresh}
					<script type="module" src="${scriptUri}"></script>
				</body>
			</html>
		`
	}

	/**
	 * 辅助：拼接扩展内资源路径并转换为 webview 可用 URI。
	 * @param pathList 资源相对扩展根目录的分段
	 * @returns webview 可访问的 URI
	 */
	private getExtensionUri(...pathList: string[]): Uri {
		return this.getWebviewUri(Uri.joinPath(this.context.extensionUri, ...pathList))
	}
}
