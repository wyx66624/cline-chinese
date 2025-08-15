import { VSCodeButton, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useState, memo } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { validateApiConfiguration } from "@/utils/validate"
import ApiOptions from "@/components/settings/ApiOptions"
import ClineLogoWhite from "@/assets/ClineLogoWhite"
import { AccountServiceClient, StateServiceClient } from "@/services/grpc-client"
import { EmptyRequest, BooleanRequest } from "@shared/proto/cline/common"

const WelcomeView = memo(() => {
	const { apiConfiguration, mode } = useExtensionState()
	const [apiErrorMessage, setApiErrorMessage] = useState<string | undefined>(undefined)
	const [showApiOptions, setShowApiOptions] = useState(false)

	const disableLetsGoButton = apiErrorMessage != null

	const handleLogin = () => {
		AccountServiceClient.accountLoginClicked(EmptyRequest.create()).catch((err) =>
			console.error("Failed to get login URL:", err),
		)
	}

	const handleSubmit = async () => {
		try {
			await StateServiceClient.setWelcomeViewCompleted(BooleanRequest.create({ value: true }))
		} catch (error) {
			console.error("Failed to update API configuration or complete welcome view:", error)
		}
	}

	useEffect(() => {
		setApiErrorMessage(validateApiConfiguration(mode, apiConfiguration))
	}, [apiConfiguration, mode])

	return (
		<div className="fixed inset-0 p-0 flex flex-col">
			<div className="h-full px-5 overflow-auto">
				<h2>你好，我是 Cline</h2>
				<div className="flex justify-center my-5">
					<ClineLogoWhite className="size-16" />
				</div>
				<p>
					我可以完成各种任务，这要归功于{" "}
					<VSCodeLink href="https://www.anthropic.com/claude/sonnet" className="inline">
						Claude 4 Sonnet
					</VSCodeLink>
					的代理编码能力和工具访问权限，让我可以创建和编辑文件、探索复杂项目、使用浏览器和执行终端命令 <i>(当然需要你的许可)</i>。我甚至可以使用 MCP 创建新工具并扩展自己的能力。
				</p>

				<p className="text-[var(--vscode-descriptionForeground)]">
					注册一个账户即可免费开始使用，或使用提供 Claude 3.7 Sonnet 等模型访问权限的 API 密钥。
				</p>

				<VSCodeButton appearance="primary" onClick={handleLogin} className="w-full mt-1">
					免费开始使用
				</VSCodeButton>

				{!showApiOptions && (
					<VSCodeButton
						appearance="secondary"
						onClick={() => setShowApiOptions(!showApiOptions)}
						className="mt-2.5 w-full">
						使用你自己的 API 密钥
					</VSCodeButton>
				)}

				<div className="mt-4.5">
					{showApiOptions && (
						<div>
							<ApiOptions showModelOptions={false} currentMode={mode} />
							<VSCodeButton onClick={handleSubmit} disabled={disableLetsGoButton} className="mt-0.75">
								开始吧！
							</VSCodeButton>
						</div>
					)}
				</div>
			</div>
		</div>
	)
})

export default WelcomeView
