import { VSCodeButton, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { handleSignIn } from "@/context/ClineAuthContext"
import ClineLogoWhite from "../../assets/ClineLogoWhite"

export const AccountWelcomeView = () => (
	<div className="flex flex-col items-center pr-3">
		<ClineLogoWhite className="size-16 mb-4" />

		<p>
			注册账户以获取最新模型的访问权限、查看使用情况和积分的计费仪表板，以及更多即将推出的功能。
		</p>

		<VSCodeButton onClick={() => handleSignIn()} className="w-full mb-4">
			使用 Cline 注册
		</VSCodeButton>

		<p className="text-[var(--vscode-descriptionForeground)] text-xs text-center m-0">
			继续即表示您同意 <VSCodeLink href="https://cline.bot/tos">服务条款</VSCodeLink> 和{" "}
			<VSCodeLink href="https://cline.bot/privacy">隐私政策。</VSCodeLink>
		</p>
	</div>
)
