import { bedrockDefaultModelId, bedrockModels, CLAUDE_SONNET_4_1M_SUFFIX } from "@shared/api"
import { VSCodeCheckbox, VSCodeDropdown, VSCodeOption, VSCodeRadio, VSCodeRadioGroup } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { ModelInfoView } from "../common/ModelInfoView"
import { DropdownContainer } from "../common/ModelSelector"
import ThinkingBudgetSlider from "../ThinkingBudgetSlider"
import { normalizeApiConfiguration, getModeSpecificFields } from "../utils/providerUtils"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"
import { Mode } from "@shared/storage/types"
// Z-index constants for proper dropdown layering
const DROPDOWN_Z_INDEX = 1000

interface BedrockProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

export const BedrockProvider = ({ showModelOptions, isPopup, currentMode }: BedrockProviderProps) => {
	const { apiConfiguration } = useExtensionState()
	const { handleFieldChange, handleFieldsChange, handleModeFieldChange, handleModeFieldsChange } = useApiConfigurationHandlers()

	const { selectedModelId, selectedModelInfo } = normalizeApiConfiguration(apiConfiguration, currentMode)
	const modeFields = getModeSpecificFields(apiConfiguration, currentMode)
	const [awsEndpointSelected, setAwsEndpointSelected] = useState(!!apiConfiguration?.awsBedrockEndpoint)

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 5,
			}}>
			<VSCodeRadioGroup
				value={apiConfiguration?.awsAuthentication ?? (apiConfiguration?.awsProfile ? "profile" : "credentials")}
				onChange={(e) => {
					const value = (e.target as HTMLInputElement)?.value
					handleFieldChange("awsAuthentication", value)
				}}>
				<VSCodeRadio value="apikey">API 密钥</VSCodeRadio>
				<VSCodeRadio value="profile">AWS 配置文件</VSCodeRadio>
				<VSCodeRadio value="credentials">AWS 凭据</VSCodeRadio>
			</VSCodeRadioGroup>

			{(apiConfiguration?.awsAuthentication === undefined && apiConfiguration?.awsUseProfile) ||
			apiConfiguration?.awsAuthentication == "profile" ? (
				<DebouncedTextField
					key="profile"
					initialValue={apiConfiguration?.awsProfile ?? ""}
					style={{ width: "100%" }}
					onChange={(value) => handleFieldChange("awsProfile", value)}
					placeholder="输入配置文件名称（留空则使用默认）">
					<span style={{ fontWeight: 500 }}>AWS 配置文件名称</span>
				</DebouncedTextField>
			) : apiConfiguration?.awsAuthentication == "apikey" ? (
				<DebouncedTextField
					key="apikey"
					type="password"
					initialValue={apiConfiguration?.awsBedrockApiKey ?? ""}
					style={{ width: "100%" }}
					onChange={(value) => handleFieldChange("awsBedrockApiKey", value)}
					placeholder="输入 Bedrock API 密钥">
					<span style={{ fontWeight: 500 }}>AWS Bedrock API 密钥</span>
				</DebouncedTextField>
			) : (
				<>
					<DebouncedTextField
						key="accessKey"
						initialValue={apiConfiguration?.awsAccessKey || ""}
						onChange={(value) => handleFieldChange("awsAccessKey", value)}
						style={{ width: "100%" }}
						type="password"
						placeholder="输入访问密钥...">
						<span style={{ fontWeight: 500 }}>AWS 访问密钥</span>
					</DebouncedTextField>
					<DebouncedTextField
						initialValue={apiConfiguration?.awsSecretKey || ""}
						onChange={(value) => handleFieldChange("awsSecretKey", value)}
						style={{ width: "100%" }}
						type="password"
						placeholder="输入密钥...">
						<span style={{ fontWeight: 500 }}>AWS 密钥</span>
					</DebouncedTextField>
					<DebouncedTextField
						initialValue={apiConfiguration?.awsSessionToken || ""}
						onChange={(value) => handleFieldChange("awsSessionToken", value)}
						style={{ width: "100%" }}
						type="password"
						placeholder="输入会话令牌...">
						<span style={{ fontWeight: 500 }}>AWS 会话令牌</span>
					</DebouncedTextField>
				</>
			)}

			<DropdownContainer zIndex={DROPDOWN_Z_INDEX - 1} className="dropdown-container">
				<label htmlFor="aws-region-dropdown">
					<span style={{ fontWeight: 500 }}>AWS 区域</span>
				</label>
				<VSCodeDropdown
					id="aws-region-dropdown"
					value={apiConfiguration?.awsRegion || ""}
					style={{ width: "100%" }}
					onChange={(e: any) => handleFieldChange("awsRegion", e.target.value)}>
					<VSCodeOption value="">选择区域...</VSCodeOption>
					{/* The user will have to choose a region that supports the model they use, but this shouldn't be a problem since they'd have to request access for it in that region in the first place. */}
					<VSCodeOption value="us-east-1">us-east-1</VSCodeOption>
					<VSCodeOption value="us-east-2">us-east-2</VSCodeOption>
					{/* <VSCodeOption value="us-west-1">us-west-1</VSCodeOption> */}
					<VSCodeOption value="us-west-2">us-west-2</VSCodeOption>
					{/* <VSCodeOption value="af-south-1">af-south-1</VSCodeOption> */}
					{/* <VSCodeOption value="ap-east-1">ap-east-1</VSCodeOption> */}
					<VSCodeOption value="ap-south-1">ap-south-1</VSCodeOption>
					<VSCodeOption value="ap-northeast-1">ap-northeast-1</VSCodeOption>
					<VSCodeOption value="ap-northeast-2">ap-northeast-2</VSCodeOption>
					<VSCodeOption value="ap-northeast-3">ap-northeast-3</VSCodeOption>
					<VSCodeOption value="ap-southeast-1">ap-southeast-1</VSCodeOption>
					<VSCodeOption value="ap-southeast-2">ap-southeast-2</VSCodeOption>
					<VSCodeOption value="ca-central-1">ca-central-1</VSCodeOption>
					<VSCodeOption value="eu-central-1">eu-central-1</VSCodeOption>
					<VSCodeOption value="eu-central-2">eu-central-2</VSCodeOption>
					<VSCodeOption value="eu-west-1">eu-west-1</VSCodeOption>
					<VSCodeOption value="eu-west-2">eu-west-2</VSCodeOption>
					<VSCodeOption value="eu-west-3">eu-west-3</VSCodeOption>
					<VSCodeOption value="eu-north-1">eu-north-1</VSCodeOption>
					<VSCodeOption value="eu-south-1">eu-south-1</VSCodeOption>
					<VSCodeOption value="eu-south-2">eu-south-2</VSCodeOption>
					{/* <VSCodeOption value="me-south-1">me-south-1</VSCodeOption> */}
					<VSCodeOption value="sa-east-1">sa-east-1</VSCodeOption>
					<VSCodeOption value="us-gov-east-1">us-gov-east-1</VSCodeOption>
					<VSCodeOption value="us-gov-west-1">us-gov-west-1</VSCodeOption>
					{/* <VSCodeOption value="us-gov-east-1">us-gov-east-1</VSCodeOption> */}
				</VSCodeDropdown>
			</DropdownContainer>

			<div style={{ display: "flex", flexDirection: "column" }}>
				<VSCodeCheckbox
					checked={awsEndpointSelected}
					onChange={(e: any) => {
						const isChecked = e.target.checked === true
						setAwsEndpointSelected(isChecked)
						if (!isChecked) {
							handleFieldChange("awsBedrockEndpoint", "")
						}
					}}>
					使用自定义 VPC 端点
				</VSCodeCheckbox>

				{awsEndpointSelected && (
					<DebouncedTextField
						initialValue={apiConfiguration?.awsBedrockEndpoint || ""}
						onChange={(value) => handleFieldChange("awsBedrockEndpoint", value)}
						style={{ width: "100%", marginTop: 3, marginBottom: 5 }}
						type="url"
						placeholder="输入 VPC 端点 URL（可选）"
					/>
				)}

				<VSCodeCheckbox
					checked={apiConfiguration?.awsUseCrossRegionInference || false}
					onChange={(e: any) => {
						const isChecked = e.target.checked === true

						handleFieldChange("awsUseCrossRegionInference", isChecked)
					}}>
					使用跨区域推理
				</VSCodeCheckbox>

				{selectedModelInfo.supportsPromptCache && (
					<>
						<VSCodeCheckbox
							checked={apiConfiguration?.awsBedrockUsePromptCache || false}
							onChange={(e: any) => {
								const isChecked = e.target.checked === true
								handleFieldChange("awsBedrockUsePromptCache", isChecked)
							}}>
							使用提示缓存
						</VSCodeCheckbox>
					</>
				)}
			</div>

			<p
				style={{
					fontSize: "12px",
					marginTop: "5px",
					color: "var(--vscode-descriptionForeground)",
				}}>
				{apiConfiguration?.awsUseProfile ? (
					<>
						使用来自 ~/.aws/credentials 的 AWS 配置文件凭据。留空配置文件名称以使用默认配置文件。这些凭据仅在本地用于从本扩展程序发出 API 请求。
					</>
				) : (
					<>
						通过提供上述密钥或使用默认 AWS 凭据提供程序进行身份验证，即 ~/.aws/credentials 或环境变量。这些凭据仅在本地用于从本扩展程序发出 API 请求。
					</>
				)}
			</p>

			{showModelOptions && (
				<>
					<label htmlFor="bedrock-model-dropdown">
						<span style={{ fontWeight: 500 }}>模型</span>
					</label>
					<DropdownContainer zIndex={DROPDOWN_Z_INDEX - 2} className="dropdown-container">
						<VSCodeDropdown
							id="bedrock-model-dropdown"
							value={modeFields.awsBedrockCustomSelected ? "custom" : selectedModelId}
							onChange={(e: any) => {
								const isCustom = e.target.value === "custom"

								handleModeFieldsChange(
									{
										apiModelId: { plan: "planModeApiModelId", act: "actModeApiModelId" },
										awsBedrockCustomSelected: {
											plan: "planModeAwsBedrockCustomSelected",
											act: "actModeAwsBedrockCustomSelected",
										},
										awsBedrockCustomModelBaseId: {
											plan: "planModeAwsBedrockCustomModelBaseId",
											act: "actModeAwsBedrockCustomModelBaseId",
										},
									},
									{
										apiModelId: isCustom ? "" : e.target.value,
										awsBedrockCustomSelected: isCustom,
										awsBedrockCustomModelBaseId: bedrockDefaultModelId,
									},
									currentMode,
								)
							}}
							style={{ width: "100%" }}>
							<VSCodeOption value="">选择模型...</VSCodeOption>
							{Object.keys(bedrockModels).map((modelId) => (
								<VSCodeOption
									key={modelId}
									value={modelId}
									style={{
										whiteSpace: "normal",
										wordWrap: "break-word",
										maxWidth: "100%",
									}}>
									{modelId}
								</VSCodeOption>
							))}
							<VSCodeOption value="custom">自定义</VSCodeOption>
						</VSCodeDropdown>
					</DropdownContainer>

					{modeFields.awsBedrockCustomSelected && (
						<div>
							<p
								style={{
									fontSize: "12px",
									marginTop: "5px",
									color: "var(--vscode-descriptionForeground)",
								}}>
								选择 "自定义" 以在 Bedrock 中使用 Application Inference Profile。在模型 ID 字段中输入 Application Inference Profile ARN。
							</p>
							<DebouncedTextField
								id="bedrock-model-input"
								initialValue={modeFields.apiModelId || ""}
								onChange={(value) =>
									handleModeFieldChange(
										{ plan: "planModeApiModelId", act: "actModeApiModelId" },
										value,
										currentMode,
									)
								}
								style={{ width: "100%", marginTop: 3 }}
								placeholder="输入自定义模型 ID...">
								<span style={{ fontWeight: 500 }}>模型 ID</span>
							</DebouncedTextField>
							<label htmlFor="bedrock-base-model-dropdown">
								<span style={{ fontWeight: 500 }}>基础推理模型</span>
							</label>
							<DropdownContainer zIndex={DROPDOWN_Z_INDEX - 3} className="dropdown-container">
								<VSCodeDropdown
									id="bedrock-base-model-dropdown"
									value={modeFields.awsBedrockCustomModelBaseId || bedrockDefaultModelId}
									onChange={(e: any) =>
										handleModeFieldChange(
											{
												plan: "planModeAwsBedrockCustomModelBaseId",
												act: "actModeAwsBedrockCustomModelBaseId",
											},
											e.target.value,
											currentMode,
										)
									}
									style={{ width: "100%" }}>
									<VSCodeOption value="">选择模型...</VSCodeOption>
									{Object.keys(bedrockModels).map((modelId) => (
										<VSCodeOption
											key={modelId}
											value={modelId}
											style={{
												whiteSpace: "normal",
												wordWrap: "break-word",
												maxWidth: "100%",
											}}>
											{modelId}
										</VSCodeOption>
									))}
								</VSCodeDropdown>
							</DropdownContainer>
						</div>
					)}

					{(selectedModelId === "anthropic.claude-3-7-sonnet-20250219-v1:0" ||
						selectedModelId === "anthropic.claude-sonnet-4-20250514-v1:0" ||
						selectedModelId === `anthropic.claude-sonnet-4-20250514-v1:0${CLAUDE_SONNET_4_1M_SUFFIX}` ||
						selectedModelId === "anthropic.claude-opus-4-1-20250805-v1:0" ||
						selectedModelId === "anthropic.claude-opus-4-20250514-v1:0" ||
						(modeFields.awsBedrockCustomSelected &&
							modeFields.awsBedrockCustomModelBaseId === "anthropic.claude-3-7-sonnet-20250219-v1:0") ||
						(modeFields.awsBedrockCustomSelected &&
							modeFields.awsBedrockCustomModelBaseId === "anthropic.claude-sonnet-4-20250514-v1:0") ||
						(modeFields.awsBedrockCustomSelected &&
							modeFields.awsBedrockCustomModelBaseId ===
								`anthropic.claude-sonnet-4-20250514-v1:0${CLAUDE_SONNET_4_1M_SUFFIX}`) ||
						(modeFields.awsBedrockCustomSelected &&
							modeFields.awsBedrockCustomModelBaseId === "anthropic.claude-opus-4-1-20250805-v1:0") ||
						(modeFields.awsBedrockCustomSelected &&
							modeFields.awsBedrockCustomModelBaseId === "anthropic.claude-opus-4-20250514-v1:0")) && (
						<ThinkingBudgetSlider currentMode={currentMode} />
					)}

					<ModelInfoView selectedModelId={selectedModelId} modelInfo={selectedModelInfo} isPopup={isPopup} />
				</>
			)}
		</div>
	)
}
