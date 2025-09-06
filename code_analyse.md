### controller\mcp中的函数作用分析
    Controller层函数	调用的 McpHub 方法	角色类型
    addRemoteMcpServer	addRemoteServer	配置增
    deleteMcpServer	deleteServerRPC	配置删
    restartMcpServer	restartConnectionRPC	连接重启
    toggleMcpServer	toggleServerDisabledRPC	启用/禁用
    toggleToolAutoApprove	toggleToolAutoApproveRPC	工具权限
    updateMcpTimeout	updateServerTimeoutRPC	配置改（超时）
    getLatestMcpServers	getLatestMcpServersRPC	查询
    openMcpSettings	getMcpSettingsFilePath + 打开编辑器	UI 辅助
    downloadMcp	addRemoteServer 之前的引导任务（间接）	Marketplace + 任务系统
    refreshMcpMarketplace	silentlyRefreshMcpMarketplaceRPC	Marketplace
    subscribeToMcpServers	getServers + 推送	状态流
    subscribeToMcpMarketplaceCatalog	外部缓存推送	Marketplace 流
    sendMcpServersUpdate（被 McpHub 调）	—	广播工具
    sendMcpMarketplaceCatalogEvent（被刷新逻辑调）	—	广播工具