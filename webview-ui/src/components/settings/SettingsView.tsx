import {
	VSCodeButton,
	VSCodeCheckbox,
	VSCodeLink,
	VSCodeTextArea,
	VSCodePanels,
	VSCodePanelTab,
	VSCodePanelView,
} from "@vscode/webview-ui-toolkit/react"
import { memo, useCallback, useEffect, useState } from "react"
import { useExtensionState } from "../../context/ExtensionStateContext"
import { validateApiConfiguration, validateModelId } from "../../utils/validate"
import { vscode } from "../../utils/vscode"
import SettingsButton from "../common/SettingsButton"
import ApiOptions from "./ApiOptions"
import { TabButton } from "../mcp/McpView"
import { useEvent } from "react-use"
import { ExtensionMessage } from "../../../../src/shared/ExtensionMessage"
const { IS_DEV } = process.env

type SettingsViewProps = {
	onDone: () => void
}

const SettingsView = ({ onDone }: SettingsViewProps) => {
	const {
		apiConfiguration,
		version,
		customInstructions,
		setCustomInstructions,
		openRouterModels,
		telemetrySetting,
		setTelemetrySetting,
		chatSettings,
		planActSeparateModelsSetting,
		setPlanActSeparateModelsSetting,
	} = useExtensionState()
	const [apiErrorMessage, setApiErrorMessage] = useState<string | undefined>(undefined)
	const [modelIdErrorMessage, setModelIdErrorMessage] = useState<string | undefined>(undefined)
	const [pendingTabChange, setPendingTabChange] = useState<"plan" | "act" | null>(null)

	const handleSubmit = (withoutDone: boolean = false) => {
		const apiValidationResult = validateApiConfiguration(apiConfiguration)
		const modelIdValidationResult = validateModelId(apiConfiguration, openRouterModels)

		// setApiErrorMessage(apiValidationResult)
		// setModelIdErrorMessage(modelIdValidationResult)

		let apiConfigurationToSubmit = apiConfiguration
		if (!apiValidationResult && !modelIdValidationResult) {
			// vscode.postMessage({ type: "apiConfiguration", apiConfiguration })
			// vscode.postMessage({
			// 	type: "customInstructions",
			// 	text: customInstructions,
			// })
			// vscode.postMessage({
			// 	type: "telemetrySetting",
			// 	text: telemetrySetting,
			// })
			// console.log("handleSubmit", withoutDone)
			// vscode.postMessage({
			// 	type: "separateModeSetting",
			// 	text: separateModeSetting,
			// })
		} else {
			// 如果 API 配置无效，我们不保存它
			apiConfigurationToSubmit = undefined
		}

		vscode.postMessage({
			type: "updateSettings",
			planActSeparateModelsSetting,
			customInstructionsSetting: customInstructions,
			telemetrySetting,
			apiConfiguration: apiConfigurationToSubmit,
		})

		if (!withoutDone) {
			onDone()
		}
	}

	useEffect(() => {
		setApiErrorMessage(undefined)
		setModelIdErrorMessage(undefined)
	}, [apiConfiguration])

	// 组件挂载后立即验证
	/*
    如果依赖项数组中未包含变量，useEffect 将使用变量的旧值。
    因此，尝试使用仅包含一个值的依赖项数组的 useEffect 将使用任何
    其他变量的旧值。在大多数情况下，您不希望这样做，而应选择使用 react-use
    钩子。

        // 使用 someVar 和 anotherVar
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [someVar])
	如果我们只想在挂载时运行一次代码，可以使用 react-use 的 useEffectOnce 或 useMount
    */

	const handleMessage = useCallback(
		(event: MessageEvent) => {
			const message: ExtensionMessage = event.data
			switch (message.type) {
				case "didUpdateSettings":
					if (pendingTabChange) {
						vscode.postMessage({
							type: "togglePlanActMode",
							chatSettings: {
								mode: pendingTabChange,
							},
						})
						setPendingTabChange(null)
					}
					break
			}
		},
		[pendingTabChange],
	)

	useEvent("message", handleMessage)

	const handleResetState = () => {
		vscode.postMessage({ type: "resetState" })
	}

	const handleTabChange = (tab: "plan" | "act") => {
		if (tab === chatSettings.mode) {
			return
		}
		setPendingTabChange(tab)
		handleSubmit(true)
	}

	return (
		<div
			style={{
				position: "fixed",
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				padding: "10px 0px 0px 20px",
				display: "flex",
				flexDirection: "column",
				overflow: "hidden",
			}}>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					marginBottom: "13px",
					paddingRight: 17,
				}}>
				<h3 style={{ color: "var(--vscode-foreground)", margin: 0 }}>设置</h3>
				<VSCodeButton onClick={() => handleSubmit(false)}>完成</VSCodeButton>
			</div>
			<div
				style={{
					flexGrow: 1,
					overflowY: "scroll",
					paddingRight: 8,
					display: "flex",
					flexDirection: "column",
				}}>
				{/* 标签页容器 */}
				{planActSeparateModelsSetting ? (
					<div
						style={{
							border: "1px solid var(--vscode-panel-border)",
							borderRadius: "4px",
							padding: "10px",
							marginBottom: "20px",
							background: "var(--vscode-panel-background)",
						}}>
						<div
							style={{
								display: "flex",
								gap: "1px",
								marginBottom: "10px",
								marginTop: -8,
								borderBottom: "1px solid var(--vscode-panel-border)",
							}}>
							<TabButton isActive={chatSettings.mode === "plan"} onClick={() => handleTabChange("plan")}>
								计划模式
							</TabButton>
							<TabButton isActive={chatSettings.mode === "act"} onClick={() => handleTabChange("act")}>
								执行模式
							</TabButton>
						</div>

						{/* 内容容器 */}
						<div style={{ marginBottom: -12 }}>
							<ApiOptions
								key={chatSettings.mode}
								showModelOptions={true}
								apiErrorMessage={apiErrorMessage}
								modelIdErrorMessage={modelIdErrorMessage}
							/>
						</div>
					</div>
				) : (
					<ApiOptions
						key={"single"}
						showModelOptions={true}
						apiErrorMessage={apiErrorMessage}
						modelIdErrorMessage={modelIdErrorMessage}
					/>
				)}

				<div style={{ marginBottom: 5 }}>
					<VSCodeTextArea
						value={customInstructions ?? ""}
						style={{ width: "100%" }}
						resize="vertical"
						rows={4}
						placeholder={"例如：“在末尾运行单元测试”，“使用 TypeScript 和 async/await”，“用西班牙语交流”"}
						onInput={(e: any) => setCustomInstructions(e.target?.value ?? "")}>
						<span style={{ fontWeight: "500" }}>自定义指令</span>
					</VSCodeTextArea>
					<p
						style={{
							fontSize: "12px",
							marginTop: "5px",
							color: "var(--vscode-descriptionForeground)",
						}}>
						这些指令会添加到每次请求发送的系统提示的末尾。
					</p>
				</div>

				<div style={{ marginBottom: 5 }}>
					<VSCodeCheckbox
						style={{ marginBottom: "5px" }}
						checked={planActSeparateModelsSetting}
						onChange={(e: any) => {
							const checked = e.target.checked === true
							setPlanActSeparateModelsSetting(checked)
						}}>
						为计划和执行模式使用不同的模型
					</VSCodeCheckbox>
					<p
						style={{
							fontSize: "12px",
							marginTop: "5px",
							color: "var(--vscode-descriptionForeground)",
						}}>
						在计划和执行模式之间切换将保留先前模式中使用的 API
						和模型。例如，当使用强大的推理模型来构建计划，然后让更便宜的编码模型来执行时，这可能会很有用。
					</p>
				</div>

				<div style={{ marginBottom: 5 }}>
					<VSCodeCheckbox
						style={{ marginBottom: "5px" }}
						checked={telemetrySetting === "enabled"}
						onChange={(e: any) => {
							const checked = e.target.checked === true
							setTelemetrySetting(checked ? "enabled" : "disabled")
						}}>
						允许匿名错误和使用情况报告
					</VSCodeCheckbox>
					<p
						style={{
							fontSize: "12px",
							marginTop: "5px",
							color: "var(--vscode-descriptionForeground)",
						}}>
						通过发送匿名使用数据和错误报告来帮助改进
						Cline。绝不会发送任何代码、提示或个人信息。有关更多详细信息，请参阅我们的{" "}
						<VSCodeLink href="https://docs.cline.bot/more-info/telemetry" style={{ fontSize: "inherit" }}>
							遥测概述
						</VSCodeLink>{" "}
						和{" "}
						<VSCodeLink href="https://cline.bot/privacy" style={{ fontSize: "inherit" }}>
							隐私政策
						</VSCodeLink>{" "}
						。
					</p>
				</div>

				{IS_DEV && (
					<>
						<div style={{ marginTop: "10px", marginBottom: "4px" }}>调试</div>
						<VSCodeButton onClick={handleResetState} style={{ marginTop: "5px", width: "auto" }}>
							重置状态
						</VSCodeButton>
						<p
							style={{
								fontSize: "12px",
								marginTop: "5px",
								color: "var(--vscode-descriptionForeground)",
							}}>
							这将重置扩展中的所有全局状态和密钥存储。
						</p>
					</>
				)}

				<div
					style={{
						marginTop: "auto",
						paddingRight: 8,
						display: "flex",
						justifyContent: "center",
					}}>
					<SettingsButton
						onClick={() => vscode.postMessage({ type: "openExtensionSettings" })}
						style={{
							margin: "0 0 16px 0",
						}}>
						<i className="codicon codicon-settings-gear" />
						高级设置
					</SettingsButton>
				</div>
				<div
					style={{
						textAlign: "center",
						color: "var(--vscode-descriptionForeground)",
						fontSize: "12px",
						lineHeight: "1.2",
						padding: "0 8px 15px 0",
					}}>
					<p
						style={{
							wordWrap: "break-word",
							margin: 0,
							padding: 0,
						}}>
						如果您有任何问题或反馈，请随时在以下地址提出问题：{" "}
						<VSCodeLink href="https://github.com/cline/cline" style={{ display: "inline" }}>
							https://github.com/cline/cline
						</VSCodeLink>
					</p>
					<p
						style={{
							fontStyle: "italic",
							margin: "10px 0 0 0",
							padding: 0,
						}}>
						v{version}
					</p>
				</div>
			</div>
		</div>
	)
}

export default memo(SettingsView)
