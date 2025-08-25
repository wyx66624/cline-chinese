import { Mode } from "@shared/storage/types"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { normalizeApiConfiguration } from "../utils/providerUtils"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { HuggingFaceModelPicker } from "../HuggingFaceModelPicker"

/**
 * Props for the HuggingFaceProvider component
 */
interface HuggingFaceProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

/**
 * The Hugging Face provider configuration component
 */
export const HuggingFaceProvider = ({ showModelOptions, isPopup, currentMode }: HuggingFaceProviderProps) => {
	const { apiConfiguration } = useExtensionState()
	const { handleFieldChange } = useApiConfigurationHandlers()

	// Get the normalized configuration
	const { selectedModelId, selectedModelInfo } = normalizeApiConfiguration(apiConfiguration, currentMode)

	return (
		<div>
			<DebouncedTextField
				initialValue={apiConfiguration?.huggingFaceApiKey || ""}
				onChange={(value) => handleFieldChange("huggingFaceApiKey", value)}
				style={{ width: "100%" }}
				type="password"
				placeholder="输入 API 密钥...">
				<span style={{ fontWeight: 500 }}>Hugging Face API 密钥</span>
			</DebouncedTextField>
			<p
				style={{
					fontSize: "12px",
					marginTop: "5px",
					color: "var(--vscode-descriptionForeground)",
				}}>
				此密钥仅存储在本地，仅用于从此扩展程序发出 API 请求。我们这里不显示定价信息，因为它取决于您的 Hugging Face 提供商设置，并且无法通过其 API 持续获取{" "}
				<a href="https://huggingface.co/settings/tokens" target="_blank" rel="noopener noreferrer">
					在此获取您的 API 密钥
				</a>
			</p>

			{showModelOptions && (
				<>
					<HuggingFaceModelPicker isPopup={isPopup} currentMode={currentMode} />
				</>
			)}
		</div>
	)
}
