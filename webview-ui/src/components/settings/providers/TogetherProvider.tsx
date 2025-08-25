import { DebouncedTextField } from "../common/DebouncedTextField"
import { ApiKeyField } from "../common/ApiKeyField"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"
import { getModeSpecificFields } from "../utils/providerUtils"
import { Mode } from "@shared/storage/types"
/**
 * Props for the TogetherProvider component
 */
interface TogetherProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

/**
 * The Together provider configuration component
 */
export const TogetherProvider = ({ showModelOptions, isPopup, currentMode }: TogetherProviderProps) => {
	const { apiConfiguration } = useExtensionState()
	const { handleFieldChange, handleModeFieldChange } = useApiConfigurationHandlers()

	const { togetherModelId } = getModeSpecificFields(apiConfiguration, currentMode)

	return (
		<div>
			<ApiKeyField
				initialValue={apiConfiguration?.togetherApiKey || ""}
				onChange={(value) => handleFieldChange("togetherApiKey", value)}
				providerName="Together"
			/>
			<DebouncedTextField
				initialValue={togetherModelId || ""}
				onChange={(value) =>
					handleModeFieldChange({ plan: "planModeTogetherModelId", act: "actModeTogetherModelId" }, value, currentMode)
				}
				style={{ width: "100%" }}
				placeholder={"输入模型 ID..."}>
				<span style={{ fontWeight: 500 }}>模型 ID</span>
			</DebouncedTextField>
			<p
				style={{
					fontSize: "12px",
					marginTop: 3,
					color: "var(--vscode-descriptionForeground)",
				}}>
				<span style={{ color: "var(--vscode-errorForeground)" }}>
					(<span style={{ fontWeight: 500 }}>注意:</span> Cline 使用复杂的提示，最好与 Claude 模型一起使用。
					能力较弱的模型可能无法按预期工作。)
				</span>
			</p>
		</div>
	)
}
