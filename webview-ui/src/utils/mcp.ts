import { McpMarketplaceCatalog, McpResource, McpResourceTemplate } from "../../../src/shared/mcp"

/**
 * 将 URI 与 URI 模板数组进行匹配，并返回匹配的模板
 * @param uri 要匹配的 URI
 * @param templates 要匹配的 URI 模板数组
 * @returns 匹配的模板，如果没有找到匹配则返回 undefined
 */
export function findMatchingTemplate(uri: string, templates: McpResourceTemplate[] = []): McpResourceTemplate | undefined {
	return templates.find((template) => {
		// 将模板转换为正则表达式模式
		const pattern = String(template.uriTemplate)
			// 首先转义特殊的正则表达式字符
			.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
			// 然后将 {param} 替换为 ([^/]+) 以匹配任何非斜杠字符
			// 我们需要使用 \{ 和 \} 因为我们刚刚转义了它们
			.replace(/\\\{([^}]+)\\\}/g, "([^/]+)")

		const regex = new RegExp(`^${pattern}$`)
		return regex.test(uri)
	})
}

/**
 * 查找给定 URI 的精确资源匹配或匹配模板
 * @param uri 要查找匹配的 URI
 * @param resources 具体资源数组
 * @param templates 资源模板数组
 * @returns 匹配的资源、模板或 undefined
 */
export function findMatchingResourceOrTemplate(
	uri: string,
	resources: McpResource[] = [],
	templates: McpResourceTemplate[] = [],
): McpResource | McpResourceTemplate | undefined {
	// 首先尝试查找精确的资源匹配
	const exactMatch = resources.find((resource) => resource.uri === uri)
	if (exactMatch) {
		return exactMatch
	}

	// 如果没有精确匹配，尝试查找匹配的模板
	return findMatchingTemplate(uri, templates)
}

/**
 * 尝试使用市场目录将 MCP 服务器名称转换为其显示名称
 * @param serverName 要查找的服务器名称/ID
 * @param mcpMarketplaceCatalog 包含服务器元数据的市场目录
 * @returns 如果在目录中找到显示名称，则返回该名称，否则返回原始服务器名称
 */
export function getMcpServerDisplayName(serverName: string, mcpMarketplaceCatalog: McpMarketplaceCatalog): string {
	// 在市场目录中查找匹配的项目
	const catalogItem = mcpMarketplaceCatalog.items.find((item) => item.mcpId === serverName)

	// 如果找到显示名称则返回，否则返回原始服务器名称
	return catalogItem?.name || serverName
}
