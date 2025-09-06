import { PostHog } from "posthog-node"
import { v4 as uuidv4 } from "uuid"
import * as vscode from "vscode"
import { posthogConfig } from "../../shared/services/config/posthog-config"
import type { ClineAccountUserInfo } from "../auth/AuthService"
import { ErrorService } from "../error/ErrorService"
import { FeatureFlagsService } from "./feature-flags/FeatureFlagsService"
import { TelemetryService } from "./telemetry/TelemetryService"

/**
 * PostHogClientProvider
 * 
 *对应功能:通过发送使用数据和错误报告帮助改进 Cline。永远不会发送代码、提示或个人信息。查看我们的 遥测概述 和 隐私政策 了解更多详情。
 *
 * 中文说明：
 * 1. 该类是一个单例（Singleton），集中管理 PostHog 分析客户端以及围绕它构建的三大服务：
 *    - telemetry: 遥测事件上报（使用 TelemetryService）
 *    - error: 错误上报（ErrorService）
 *    - featureFlags: 特性开关（FeatureFlagsService）
 * 2. 区分三层“是否允许发送”的来源：
 *    - VS Code / Host 全局是否允许收集（host）
 *    - 扩展自身配置是否允许（cline）
 *    - 具体粒度级别（level: all | error | crash | off）
 * 3. 若做“内核（仅后端逻辑）”精简，可直接删除本文件以及引用它的各服务，并在调用处加空实现（No-Op）。
 * 4. ENV_ID 获取顺序：Host 提供的 UUID -> VSCode machineId -> 随机 UUID，保证 distinctId 稳定。\n
 */

// English: Prefer host-provided UUID when running via HostBridge; fall back to VS Code's machineId, then a random UUID
// 中文：优先使用 HostBridge 提供的 UUID；否则使用 VS Code machineId；再否则生成随机 UUID。
const ENV_ID = process?.env?.UUID ?? vscode?.env?.machineId ?? uuidv4()

interface TelemetrySettings {
	/** 是否允许扩展自身（cline）发送遥测 */
	cline: boolean
	/** VS Code / 宿主层面的遥测开关 */
	host: boolean
	/** 级别：all(全部事件) / off(关闭) / error(仅错误) / crash(仅崩溃，当前逻辑与 error 类似) */
	level?: "all" | "off" | "error" | "crash"
}

export class PostHogClientProvider {
	/** 单例缓存 */
	private static _instance: PostHogClientProvider | null = null

	/**
	 * 获取单例实例；首次创建时可传入 distinctId。
	 * @param id 外部自定义 distinctId（可选）
	 */
	public static getInstance(id?: string): PostHogClientProvider {
		if (!PostHogClientProvider._instance) {
			PostHogClientProvider._instance = new PostHogClientProvider(id)
		}
		return PostHogClientProvider._instance
	}

	/** 当前遥测设置状态（受用户配置与 VSCode 全局控制共同影响） */
	protected telemetrySettings: TelemetrySettings = {
		cline: true,
		host: true,
		level: "all",
	}

	/** PostHog 原生客户端实例 */
	public readonly client: PostHog

	/** 特性开关服务（不受 telemetry 开关影响，应始终可用） */
	public readonly featureFlags: FeatureFlagsService
	/** 遥测事件服务 */
	public readonly telemetry: TelemetryService
	/** 错误事件上报服务 */
	public readonly error: ErrorService

	private constructor(public distinctId = ENV_ID) {
		// 初始化 PostHog 客户端
		this.client = new PostHog(posthogConfig.apiKey, {
			host: posthogConfig.host,
		})

		// 监听 VS Code 全局遥测开关变化
		vscode.env.onDidChangeTelemetryEnabled((isTelemetryEnabled) => {
			this.telemetrySettings.host = isTelemetryEnabled
		})

		// 启动时若 host 遥测关闭则同步关闭
		if (vscode?.env?.isTelemetryEnabled === false) {
			this.telemetrySettings.host = false
		}

		// 读取扩展配置中的遥测开关
		const config = vscode.workspace.getConfiguration("cline")
		if (config.get("telemetrySetting") === "disabled") {
			this.telemetrySettings.cline = false
		}

		this.telemetrySettings.level = this.telemetryLevel

		// 初始化子服务
		this.telemetry = new TelemetryService(this)
		this.error = new ErrorService(this, this.distinctId)
		this.featureFlags = new FeatureFlagsService(
			(flag: string) => this.client.getFeatureFlag(flag, this.distinctId),
			(flag: string) => this.client.getFeatureFlagPayload(flag, this.distinctId),
		)
	}

	/** 当前是否允许发送任何遥测事件 */
	private get isTelemetryEnabled(): boolean {
		return this.telemetrySettings.cline && this.telemetrySettings.host
	}

	/**
	 * 计算当前遥测级别（整合 VS Code 全局设置）。
	 * VS Code 全局关闭时直接视为 off。
	 */
	private get telemetryLevel(): TelemetrySettings["level"] {
		if (!vscode?.env?.isTelemetryEnabled) {
			return "off"
		}
		const config = vscode.workspace.getConfiguration("telemetry")
		return config?.get<TelemetrySettings["level"]>("telemetryLevel") || "all"
	}

	/**
	 * 切换扩展本身的遥测开关（不改变 VS Code 全局设置）。
	 * @param optIn 是否允许
	 */
	public toggleOptIn(optIn: boolean): void {
		if (optIn && !this.telemetrySettings.cline) {
			this.client.optIn()
		}
		if (!optIn && this.telemetrySettings.cline) {
			this.client.optOut()
		}
		this.telemetrySettings.cline = optIn
	}

	/**
	 * 账户识别：将匿名 distinctId 与登录账户 ID 关联。
	 * 若传入的 userInfo.id 与当前 distinctId 不同，则调用 identify 并更新 distinctId。
	 */
	public identifyAccount(userInfo?: ClineAccountUserInfo, properties: Record<string, unknown> = {}): void {
		if (!this.isTelemetryEnabled) {
			return
		}
		if (userInfo && userInfo?.id !== this.distinctId) {
			this.client.identify({
				distinctId: userInfo.id,
				properties: {
					uuid: userInfo.id,
					email: userInfo.email,
					name: userInfo.displayName,
					...properties,
					alias: this.distinctId, // 用 alias 关联之前的匿名 ID
				},
			})
			this.distinctId = userInfo.id
		}
	}

	/**
	 * 发送事件（统一入口）。会根据当前级别过滤：
	 * - off: 全部忽略
	 * - error: 仅包含名称包含 "error" 的事件
	 */
	public log(event: string, properties?: Record<string, unknown>): void {
		if (!this.isTelemetryEnabled || this.telemetryLevel === "off") {
			return
		}
		if (this.telemetryLevel === "error") {
			if (!event.includes("error")) {
				return
			}
		}

		this.client.capture({
			distinctId: this.distinctId,
			event,
			properties,
		})
	}

	/** 释放资源（进程结束/扩展停用时调用） */
	public dispose(): void {
		this.client.shutdown().catch((error) => console.error("Error shutting down PostHog client:", error))
	}
}

const getFeatureFlagsService = (): FeatureFlagsService => PostHogClientProvider.getInstance().featureFlags
const getErrorService = (): ErrorService => PostHogClientProvider.getInstance().error
const getTelemetryService = (): TelemetryService => PostHogClientProvider.getInstance().telemetry

// Service accessors / 服务访问器（保持向后兼容的便捷导出）
export const featureFlagsService = getFeatureFlagsService()
export const errorService = getErrorService()
export const telemetryService = getTelemetryService()
