import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { TabButton } from "../../mcp/configuration/McpConfigurationView"
import ApiOptions from "../ApiOptions"
import Section from "../Section"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { useState } from "react"
import { syncModeConfigurations } from "../utils/providerUtils"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"
import { Mode } from "@shared/storage/types"
interface ApiConfigurationSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const ApiConfigurationSection = ({ renderSectionHeader }: ApiConfigurationSectionProps) => {
	const { planActSeparateModelsSetting, mode, apiConfiguration } = useExtensionState()
	const [currentTab, setCurrentTab] = useState<Mode>(mode)
	const { handleFieldsChange } = useApiConfigurationHandlers()
	return (
		<div>
			{renderSectionHeader("api-config")}
			<Section>
				{/* 标签页容器 */}
				{planActSeparateModelsSetting ? (
					<div className="rounded-md mb-5 bg-[var(--vscode-panel-background)]">
						<div className="flex gap-[1px] mb-[10px] -mt-2 border-0 border-b border-solid border-[var(--vscode-panel-border)]">
							<TabButton
								isActive={currentTab === "plan"}
								onClick={() => setCurrentTab("plan")}
								disabled={currentTab === "plan"}
								style={{
									opacity: 1,
									cursor: "pointer",
								}}>
								计划模式
							</TabButton>
							<TabButton
								isActive={currentTab === "act"}
								onClick={() => setCurrentTab("act")}
								disabled={currentTab === "act"}
								style={{
									opacity: 1,
									cursor: "pointer",
								}}>
								执行模式
							</TabButton>
						</div>

						{/* 内容容器 */}
						<div className="-mb-3">
							<ApiOptions showModelOptions={true} currentMode={currentTab} />
						</div>
					</div>
				) : (
					<ApiOptions showModelOptions={true} currentMode={mode} />
				)}

				<div className="mb-[5px]">
					<VSCodeCheckbox
						className="mb-[5px]"
						checked={planActSeparateModelsSetting}
						onChange={async (e: any) => {
							const checked = e.target.checked === true
							try {
								// 如果取消勾选切换器，等待一下让状态更新，然后同步配置
								if (!checked) {
									await syncModeConfigurations(apiConfiguration, currentTab, handleFieldsChange)
								}
								await StateServiceClient.updateSettings(
									UpdateSettingsRequest.create({
										planActSeparateModelsSetting: checked,
									}),
								)
							} catch (error) {
								console.error("Failed to update separate models setting:", error)
							}
						}}>
						为计划和执行模式使用不同的模型
					</VSCodeCheckbox>
					<p className="text-xs mt-[5px] text-[var(--vscode-descriptionForeground)]">
						在计划和执行模式之间切换将保持前一模式中使用的 API
						和模型。这可能很有用，例如当使用强推理模型来构建计划供更便宜的编码模型执行时。
					</p>
				</div>
			</Section>
		</div>
	)
}

export default ApiConfigurationSection
