import { z } from "zod"
import { DEFAULT_MCP_TIMEOUT_SECONDS, MIN_MCP_TIMEOUT_SECONDS } from "@shared/mcp"
import { TYPE_ERROR_MESSAGE } from "./constants"

/**
 * 格式验证
 * 本文件定义 MCP 服务器配置的 Zod 校验 Schema。
 * 目标：
 *  1. 统一不同传输类型 (stdio / sse / streamableHttp) 的字段约束
 *  2. 兼容旧字段 transportType（迁移期仍可读取）
 *  3. 对 timeout / URL 等关键字段提供格式与最小值校验
 */

/** 自动批准的工具名称列表 */
export const AutoApproveSchema = z.array(z.string()).default([])

/**
 * 基础配置：
 *  - autoApprove: 工具名白名单，调用无需人工确认
 *  - disabled: 是否禁用该服务器
 *  - timeout: 单次工具调用超时时间（秒）
 */
export const BaseConfigSchema = z.object({
	autoApprove: AutoApproveSchema.optional(),
	disabled: z.boolean().optional(),
	timeout: z.number().min(MIN_MCP_TIMEOUT_SECONDS).optional().default(DEFAULT_MCP_TIMEOUT_SECONDS),
})

/**
 * 创建多传输类型联合 Schema，并对 legacy 字段做归一化：
 *  - stdio: 需要 command/args/env
 *  - sse: 需要 url
 *  - streamableHttp: 需要 url（老版本 transportType = http）
 */
const createServerTypeSchema = () => {
	return z.union([
		// stdio 配置（要求存在 command）
		BaseConfigSchema.extend({
			type: z.literal("stdio").optional(),
			transportType: z.string().optional(), // Support legacy field
			command: z.string(),
			args: z.array(z.string()).optional(),
			cwd: z.string().optional(),
			env: z.record(z.string()).optional(),
			// Allow other fields for backward compatibility
			url: z.string().optional(),
			headers: z.record(z.string()).optional(),
		})
			.transform((data) => {
				// 支持新旧字段：type 或 legacy transportType
				const finalType = data.type || (data.transportType === "stdio" ? "stdio" : undefined) || "stdio"
				return {
					...data,
					type: finalType as "stdio",
					// Remove the legacy field after transformation
					transportType: undefined,
				}
			})
			.refine((data) => data.type === "stdio", { message: TYPE_ERROR_MESSAGE }),
		// SSE 配置（要求 url）
		BaseConfigSchema.extend({
			type: z.literal("sse").optional(),
			transportType: z.string().optional(), // Support legacy field
			url: z.string().url("URL must be a valid URL format"),
			headers: z.record(z.string()).optional(),
			// Allow other fields for backward compatibility
			command: z.string().optional(),
			args: z.array(z.string()).optional(),
			env: z.record(z.string()).optional(),
		})
			.transform((data) => {
				// 支持新旧字段：type / transportType
				const finalType = data.type || (data.transportType === "sse" ? "sse" : undefined) || "sse"
				return {
					...data,
					type: finalType as "sse",
					// Remove the legacy field after transformation
					transportType: undefined,
				}
			})
			.refine((data) => data.type === "sse", { message: TYPE_ERROR_MESSAGE }),
		// 可流式 HTTP 配置（streamableHttp，旧值 http）
		BaseConfigSchema.extend({
			type: z.literal("streamableHttp").optional(),
			transportType: z.string().optional(), // Support legacy field
			url: z.string().url("URL must be a valid URL format"),
			headers: z.record(z.string()).optional(),
			// Allow other fields for backward compatibility
			command: z.string().optional(),
			args: z.array(z.string()).optional(),
			env: z.record(z.string()).optional(),
		})
			.transform((data) => {
				// 支持新旧字段；legacy transportType 使用 "http" 表示
				const finalType = data.type || (data.transportType === "http" ? "streamableHttp" : undefined) || "streamableHttp"
				return {
					...data,
					type: finalType as "streamableHttp",
					// Remove the legacy field after transformation
					transportType: undefined,
				}
			})
			.refine((data) => data.type === "streamableHttp", {
				message: TYPE_ERROR_MESSAGE,
			}),
	])
}

export const ServerConfigSchema = createServerTypeSchema()

export const McpSettingsSchema = z.object({
	mcpServers: z.record(ServerConfigSchema),
})
