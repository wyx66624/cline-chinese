/**
 * FeatureFlagsService
 * English: Provides feature flag querying independent of telemetry opt-in.
 * 中文：特性开关服务，独立于遥测开关工作；即使用户关闭遥测也需要继续拉取远端开关，以便控制扩展行为。
 * 典型用途：灰度发布、按服务器端配置开启/关闭某些功能（例如 focus chain）。
 * 做“内核化裁剪”时：若不再需要远端动态控制功能，可删除本文件，并将引用处替换为返回默认布尔值的空实现。
 */
export class FeatureFlagsService {
	public constructor(
		private readonly getFeatureFlag: (flag: string) => Promise<boolean | string | undefined>,
		private readonly getFeatureFlagPayload: (flag: string) => Promise<unknown>,
	) {
		console.log("[FeatureFlagsService] Initialized")
	}

	/**
	 * 检查某特性开关是否启用（不依赖遥测配置）。
	 * @param flagName 开关名称
	 * @returns 是否启用
	 */
	public async isFeatureFlagEnabled(flagName: string): Promise<boolean> {
		try {
			const flagEnabled = await this.getFeatureFlag(flagName)
			return flagEnabled === true
		} catch (error) {
			console.error(`Error checking if feature flag ${flagName} is enabled:`, error)
			return false
		}
	}

	/**
	 * 安全封装：获取布尔型开关，失败时返回默认值。
	 */
	public async getBooleanFlagEnabled(flagName: string, defaultValue = false): Promise<boolean> {
		try {
			return await this.isFeatureFlagEnabled(flagName)
		} catch (error) {
			console.error(`Error getting boolean flag ${flagName}:`, error)
			return defaultValue
		}
	}

	/**
	 * 便捷方法：Focus Chain 功能远程开关。
	 */
	public async getFocusChainEnabled(): Promise<boolean> {
		return this.getBooleanFlagEnabled("focus_chain_checklist", false)
	}

	/**
	 * 获取特性开关的载荷（可用于传复杂 JSON 参数）。
	 * @param flagName 开关名称
	 * @returns 载荷或 null
	 */
	public async getPayload(flagName: string): Promise<unknown> {
		try {
			return await this.getFeatureFlagPayload(flagName)
		} catch (error) {
			console.error(`Error retrieving feature flag payload for ${flagName}:`, error)
			return null
		}
	}
}
