import { VSCodeButton, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { useShengSuanYunAuth } from "@/context/ShengSuanYunAuthContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"
import { WebServiceClient } from "@/services/grpc-client"
import { StringRequest } from "@shared/proto/common"

export const ShengSuanYunAccountInfoCard = () => {
	const { userSSY: ssyUser } = useShengSuanYunAuth()
	const { userInfo, apiConfiguration, navigateToAccount } = useExtensionState()
	let user = apiConfiguration?.shengSuanYunToken ? ssyUser || userInfo : undefined

	// 打开特定网页的函数
	const openWebPage = async (url: string) => {
		try {
			await WebServiceClient.openInBrowser(
				StringRequest.create({
					value: url,
				}),
			)
		} catch (error) {
			console.error("Error opening URL in browser:", error)
		}
	}

	return (
		<div className="max-w-[600px]">
			{user?.Wallet ? (
				<VSCodeButton
					appearance="secondary"
					onClick={() => {
						openWebPage("https://router.shengsuanyun.com/user/bill")
					}}>
					查看账单与使用记录
				</VSCodeButton>
			) : (
				<VSCodeButton
					appearance="primary"
					onClick={() => {
						vscode.postMessage({ type: "accountLoginClickedSSY" })
					}}>
					登录胜算云Router
				</VSCodeButton>
			)}
		</div>
	)
}
