export interface AutoApprovalSettings {
	// 是否启用自动批准
	enabled: boolean
	// 单个操作权限
	actions: {
		readFiles: boolean // 读取文件和目录
		editFiles: boolean // 编辑文件
		executeCommands: boolean // 执行安全命令
		useBrowser: boolean // 使用浏览器
		useMcp: boolean // 使用 MCP 服务器
	}
	// 全局设置
	maxRequests: number // 自动批准请求的最大数量
	enableNotifications: boolean // 显示批准和任务完成的通知
}

export const DEFAULT_AUTO_APPROVAL_SETTINGS: AutoApprovalSettings = {
	enabled: false,
	actions: {
		readFiles: false,
		editFiles: false,
		executeCommands: false,
		useBrowser: false,
		useMcp: false,
	},
	maxRequests: 20,
	enableNotifications: false,
}
