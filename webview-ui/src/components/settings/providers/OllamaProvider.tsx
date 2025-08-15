import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { useState, useCallback, useEffect } from "react"
import { useInterval } from "react-use"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { ApiKeyField } from "../common/ApiKeyField"
import { ModelsServiceClient } from "@/services/grpc-client"
import { StringRequest } from "@shared/proto/cline/common"
import OllamaModelPicker from "../OllamaModelPicker"
import { BaseUrlField } from "../common/BaseUrlField"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"
import { getModeSpecificFields } from "../utils/providerUtils"
import { Mode } from "@shared/storage/types"
/**
 * Props for the OllamaProvider component
 */
interface OllamaProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

/**
 * The Ollama provider configuration component
 */
export const OllamaProvider = ({ showModelOptions, isPopup, currentMode }: OllamaProviderProps) => {
	const { apiConfiguration } = useExtensionState()
	const { handleFieldChange, handleModeFieldChange } = useApiConfigurationHandlers()

	const { ollamaModelId } = getModeSpecificFields(apiConfiguration, currentMode)

	const [ollamaModels, setOllamaModels] = useState<string[]>([])

	// Poll ollama models
	const requestOllamaModels = useCallback(async () => {
		try {
			const response = await ModelsServiceClient.getOllamaModels(
				StringRequest.create({
					value: apiConfiguration?.ollamaBaseUrl || "",
				}),
			)
			if (response && response.values) {
				setOllamaModels(response.values)
			}
		} catch (error) {
			console.error("Failed to fetch Ollama models:", error)
			setOllamaModels([])
		}
	}, [apiConfiguration?.ollamaBaseUrl])

	useEffect(() => {
		requestOllamaModels()
	}, [requestOllamaModels])

	useInterval(requestOllamaModels, 2000)

	return (
		<div>
			<BaseUrlField
				initialValue={apiConfiguration?.ollamaBaseUrl}
				onChange={(value) => handleFieldChange("ollamaBaseUrl", value)}
				placeholder="默认: http://localhost:11434"
				label="使用自定义基础 URL"
			/>

			{apiConfiguration?.ollamaBaseUrl && (
				<ApiKeyField
					initialValue={apiConfiguration?.ollamaApiKey || ""}
					onChange={(value) => handleFieldChange("ollamaApiKey", value)}
					providerName="Ollama"
					placeholder="输入 API 密钥（可选）..."
					helpText="用于经过身份验证的 Ollama 实例或云服务的可选 API 密钥。本地安装请留空。"
				/>
			)}

			{/* Model selection - use filterable picker */}
			<label htmlFor="ollama-model-selection">
				<span style={{ fontWeight: 500 }}>模型</span>
			</label>
			<OllamaModelPicker
				ollamaModels={ollamaModels}
				selectedModelId={ollamaModelId || ""}
				onModelChange={(modelId) => {
					handleModeFieldChange({ plan: "planModeOllamaModelId", act: "actModeOllamaModelId" }, modelId, currentMode)
				}}
				placeholder={ollamaModels.length > 0 ? "搜索并选择模型..." : "例如 llama3.1"}
			/>

			{/* Show status message based on model availability */}
			{ollamaModels.length === 0 && (
				<p
					style={{
						fontSize: "12px",
						marginTop: "3px",
						color: "var(--vscode-descriptionForeground)",
						fontStyle: "italic",
					}}>
					Unable to fetch models from Ollama server. Please ensure Ollama is running and accessible, or enter the model
					ID manually above.
				</p>
			)}

			<DebouncedTextField
				initialValue={apiConfiguration?.ollamaApiOptionsCtxNum || "32768"}
				onChange={(value) => handleFieldChange("ollamaApiOptionsCtxNum", value)}
				style={{ width: "100%" }}
				placeholder={"例如 32768"}>
				<span style={{ fontWeight: 500 }}>模型上下文窗口</span>
			</DebouncedTextField>

			{showModelOptions && (
				<>
					<DebouncedTextField
						initialValue={apiConfiguration?.requestTimeoutMs ? apiConfiguration.requestTimeoutMs.toString() : "30000"}
						onChange={(value) => {
							// Convert to number, with validation
							const numValue = parseInt(value, 10)
							if (!isNaN(numValue) && numValue > 0) {
								handleFieldChange("requestTimeoutMs", numValue)
							}
						}}
						style={{ width: "100%" }}
						placeholder="默认: 30000 (30 秒)">
						<span style={{ fontWeight: 500 }}>请求超时（毫秒）</span>
					</DebouncedTextField>
					<p style={{ fontSize: "12px", marginTop: 3, color: "var(--vscode-descriptionForeground)" }}>
						等待 API 响应的最大时间（毫秒），超过后将超时。
					</p>
				</>
			)}

			<p
				style={{
					fontSize: "12px",
					marginTop: "5px",
					color: "var(--vscode-descriptionForeground)",
				}}>
				Ollama 允许您在计算机上本地运行模型。有关如何开始的说明，请参阅他们的{" "}
				<VSCodeLink
					href="https://github.com/ollama/ollama/blob/main/README.md"
					style={{ display: "inline", fontSize: "inherit" }}>
					快速入门指南。
				</VSCodeLink>{" "}
				<span style={{ color: "var(--vscode-errorForeground)" }}>
					(<span style={{ fontWeight: 500 }}>注意:</span> Cline 使用复杂的提示，最好与 Claude 模型一起使用。
					能力较弱的模型可能无法按预期工作。)
				</span>
			</p>
		</div>
	)
}
