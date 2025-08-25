import { ApiConfiguration, askSageModels, askSageDefaultURL } from "@shared/api"
import { ApiKeyField } from "../common/ApiKeyField"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { ModelSelector } from "../common/ModelSelector"
import { ModelInfoView } from "../common/ModelInfoView"
import { normalizeApiConfiguration } from "../utils/providerUtils"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"
import { Mode } from "@shared/storage/types"
/**
 * Props for the AskSageProvider component
 */
interface AskSageProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

/**
 * The AskSage provider configuration component
 */
export const AskSageProvider = ({ showModelOptions, isPopup, currentMode }: AskSageProviderProps) => {
	const { apiConfiguration } = useExtensionState()
	const { handleFieldChange, handleModeFieldChange } = useApiConfigurationHandlers()

	// Get the normalized configuration
	const { selectedModelId, selectedModelInfo } = normalizeApiConfiguration(apiConfiguration, currentMode)

	return (
		<div>
			<ApiKeyField
				initialValue={apiConfiguration?.asksageApiKey || ""}
				onChange={(value) => handleFieldChange("asksageApiKey", value)}
				providerName="AskSage"
				helpText="此密钥已本地存储，仅用于从本扩展程序发出 API 请求。"
			/>

			<DebouncedTextField
				initialValue={apiConfiguration?.asksageApiUrl || askSageDefaultURL}
				onChange={(value) => handleFieldChange("asksageApiUrl", value)}
				style={{ width: "100%" }}
				type="url"
				placeholder="输入 AskSage API URL...">
				<span style={{ fontWeight: 500 }}>AskSage API URL</span>
			</DebouncedTextField>

			{showModelOptions && (
				<>
					<ModelSelector
						models={askSageModels}
						selectedModelId={selectedModelId}
						onChange={(e) =>
							handleModeFieldChange(
								{ plan: "planModeApiModelId", act: "actModeApiModelId" },
								e.target.value,
								currentMode,
							)
						}
						label="模型"
					/>

					<ModelInfoView selectedModelId={selectedModelId} modelInfo={selectedModelInfo} isPopup={isPopup} />
				</>
			)}
		</div>
	)
}
