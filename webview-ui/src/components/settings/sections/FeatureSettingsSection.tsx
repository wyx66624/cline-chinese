import { VSCodeCheckbox, VSCodeDropdown, VSCodeOption, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { memo } from "react"
import { OpenaiReasoningEffort } from "@shared/storage/types"
import { updateSetting } from "../utils/settingsHandlers"
import { McpDisplayMode } from "@shared/McpDisplayMode"
import McpDisplayModeDropdown from "@/components/mcp/chat-display/McpDisplayModeDropdown"
import Section from "../Section"

interface FeatureSettingsSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const FeatureSettingsSection = ({ renderSectionHeader }: FeatureSettingsSectionProps) => {
	const {
		enableCheckpointsSetting,
		mcpMarketplaceEnabled,
		mcpDisplayMode,
		mcpResponsesCollapsed,
		openaiReasoningEffort,
		strictPlanModeEnabled,
		focusChainSettings,
		focusChainFeatureFlagEnabled,
	} = useExtensionState()

	const handleReasoningEffortChange = (newValue: OpenaiReasoningEffort) => {
		updateSetting("openaiReasoningEffort", newValue)
	}

	return (
		<div>
			{renderSectionHeader("features")}
			<Section>
				<div style={{ marginBottom: 20 }}>
					<div>
						<VSCodeCheckbox
							checked={enableCheckpointsSetting}
							onChange={(e: any) => {
								const checked = e.target.checked === true
								updateSetting("enableCheckpointsSetting", checked)
							}}>
							启用检查点
						</VSCodeCheckbox>
						<p className="text-xs text-[var(--vscode-descriptionForeground)]">
							启用扩展在整个任务过程中保存工作区检查点。在底层使用 git，可能不适用于大型工作区。
						</p>
					</div>
					<div style={{ marginTop: 10 }}>
						<VSCodeCheckbox
							checked={mcpMarketplaceEnabled}
							onChange={(e: any) => {
								const checked = e.target.checked === true
								updateSetting("mcpMarketplaceEnabled", checked)
							}}>
							启用 MCP 市场
						</VSCodeCheckbox>
						<p className="text-xs text-[var(--vscode-descriptionForeground)]">
							启用 MCP 市场标签页，用于发现和安装 MCP 服务器。
						</p>
					</div>
					<div style={{ marginTop: 10 }}>
						<label
							htmlFor="mcp-display-mode-dropdown"
							className="block text-sm font-medium text-[var(--vscode-foreground)] mb-1">
							MCP 显示模式
						</label>
						<McpDisplayModeDropdown
							id="mcp-display-mode-dropdown"
							value={mcpDisplayMode}
							onChange={(newMode: McpDisplayMode) => updateSetting("mcpDisplayMode", newMode)}
							className="w-full"
						/>
						<p className="text-xs mt-[5px] text-[var(--vscode-descriptionForeground)]">
							控制 MCP 响应的显示方式：纯文本、带链接/图片的丰富格式或 markdown 渲染。
						</p>
					</div>
					<div style={{ marginTop: 10 }}>
						<VSCodeCheckbox
							checked={mcpResponsesCollapsed}
							onChange={(e: any) => {
								const checked = e.target.checked === true
								updateSetting("mcpResponsesCollapsed", checked)
							}}>
							折叠 MCP 响应
						</VSCodeCheckbox>
						<p className="text-xs text-[var(--vscode-descriptionForeground)]">
							设置 MCP 响应面板的默认显示模式
						</p>
					</div>
					<div style={{ marginTop: 10 }}>
						<label
							htmlFor="openai-reasoning-effort-dropdown"
							className="block text-sm font-medium text-[var(--vscode-foreground)] mb-1">
							OpenAI 推理努力程度
						</label>
						<VSCodeDropdown
							id="openai-reasoning-effort-dropdown"
							currentValue={openaiReasoningEffort || "medium"}
							onChange={(e: any) => {
								const newValue = e.target.currentValue as OpenaiReasoningEffort
								handleReasoningEffortChange(newValue)
							}}
							className="w-full">
							<VSCodeOption value="low">低</VSCodeOption>
							<VSCodeOption value="medium">中等</VSCodeOption>
							<VSCodeOption value="high">高</VSCodeOption>
						</VSCodeDropdown>
						<p className="text-xs mt-[5px] text-[var(--vscode-descriptionForeground)]">
							OpenAI 系列模型的推理努力程度（适用于所有 OpenAI 模型提供商）
						</p>
					</div>
					<div style={{ marginTop: 10 }}>
						<VSCodeCheckbox
							checked={strictPlanModeEnabled}
							onChange={(e: any) => {
								const checked = e.target.checked === true
								updateSetting("strictPlanModeEnabled", checked)
							}}>
							启用严格计划模式
						</VSCodeCheckbox>
						<p className="text-xs text-[var(--vscode-descriptionForeground)]">
							在计划模式下强制执行严格的工具使用，防止文件编辑。
						</p>
					</div>
					{focusChainFeatureFlagEnabled && (
						<div style={{ marginTop: 10 }}>
							<VSCodeCheckbox
								checked={focusChainSettings?.enabled || false}
								onChange={(e: any) => {
									const checked = e.target.checked === true
									updateSetting("focusChainSettings", { ...focusChainSettings, enabled: checked })
								}}>
								启用焦点链
							</VSCodeCheckbox>
							<p className="text-xs text-[var(--vscode-descriptionForeground)]">
								启用增强的任务进度跟踪和整个任务过程中的自动焦点链列表管理。
							</p>
						</div>
					)}
					{focusChainFeatureFlagEnabled && focusChainSettings?.enabled && (
						<div style={{ marginTop: 10, marginLeft: 20 }}>
							<label
								htmlFor="focus-chain-remind-interval"
								className="block text-sm font-medium text-[var(--vscode-foreground)] mb-1">
								焦点链提醒间隔
							</label>
							<VSCodeTextField
								id="focus-chain-remind-interval"
								value={String(focusChainSettings?.remindClineInterval || 6)}
								onChange={(e: any) => {
									const value = parseInt(e.target.value, 10)
									if (!isNaN(value) && value >= 1 && value <= 100) {
										updateSetting("focusChainSettings", {
											...focusChainSettings,
											remindClineInterval: value,
										})
									}
								}}
								className="w-20"
							/>
							<p className="text-xs mt-[5px] text-[var(--vscode-descriptionForeground)]">
								提醒 Cline 关于其焦点链检查清单的间隔（以消息为单位，1-100）。较低的值提供更频繁的提醒。
							</p>
						</div>
					)}
				</div>
			</Section>
		</div>
	)
}

export default memo(FeatureSettingsSection)
