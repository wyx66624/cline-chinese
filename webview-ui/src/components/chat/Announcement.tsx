import { VSCodeButton, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { memo } from "react"
import { getAsVar, VSC_DESCRIPTION_FOREGROUND, VSC_INACTIVE_SELECTION_BACKGROUND } from "../../utils/vscStyles"
import { vscode } from "../../utils/vscode"

interface AnnouncementProps {
	version: string
	hideAnnouncement: () => void
}

/*
您必须更新 ClineProvider 中的 latestAnnouncementId 才能向用户显示新的公告。这个新的 id 将与状态中“上次显示的公告”进行比较，如果不同，则会呈现公告。一旦公告显示，该 id 将在状态中更新。这确保了即使在用户自己不关闭公告的情况下，公告也不会显示多次。
*/
const Announcement = ({ version, hideAnnouncement }: AnnouncementProps) => {
	const minorVersion = version.split(".").slice(0, 2).join(".") // 2.0.0 -> 2.0
	return (
		<div
			style={{
				backgroundColor: getAsVar(VSC_INACTIVE_SELECTION_BACKGROUND),
				borderRadius: "3px",
				padding: "12px 16px",
				margin: "5px 15px 5px 15px",
				position: "relative",
				flexShrink: 0,
			}}>
			<VSCodeButton appearance="icon" onClick={hideAnnouncement} style={{ position: "absolute", top: "8px", right: "8px" }}>
				<span className="codicon codicon-close"></span>
			</VSCodeButton>
			<h3 style={{ margin: "0 0 8px" }}>
				🎉{"  "}v{minorVersion} 新功能
			</h3>
			<ul style={{ margin: "0 0 8px", paddingLeft: "12px" }}>
				<li>
					<b>Cline Chinese特色功能：新增Dify Provider：</b> 使用自定义的Dify
					Provider，您可以轻松地使用Dify的强大功能，从而让Cline更加智能。
				</li>
				<li>
					<b>添加到 Cline：</b>{" "}
					在任何文件或终端中右键单击选定的文本，以快速将上下文添加到您当前的任务中！此外，当您看到灯泡图标时，选择“使用
					Cline 修复”让 Cline 修复您代码中的错误。
				</li>
				<li>
					<b>账单仪表板：</b> 使用 <span className="codicon codicon-account" style={{ fontSize: 11 }}></span> Cline
					账户，直接在扩展程序中跟踪您剩余的积分和交易历史记录！
				</li>
				<li>
					<b>更快的推理：</b> Cline/OpenRouter
					用户可以按吞吐量、价格和延迟对使用的底层提供商进行排序。按吞吐量排序将输出更快的生成结果（成本更高）。
				</li>
				<li>
					<b>增强的 MCP 支持：</b> 支持 GIF 的动态图像加载，以及一个新的删除按钮来清理失败的服务器。
				</li>
			</ul>
			{/*<ul style={{ margin: "0 0 8px", paddingLeft: "12px" }}>
				 <li>
					OpenRouter 现在支持提示缓存！它们还具有比其他提供商高得多的速率限制，所以我建议您尝试一下。
					<br />
					{!apiConfiguration?.openRouterApiKey && (
						<VSCodeButtonLink
							href={getOpenRouterAuthUrl(vscodeUriScheme)}
							style={{
								transform: "scale(0.85)",
								transformOrigin: "left center",
								margin: "4px -30px 2px 0",
							}}>
							获取 OpenRouter API 密钥
						</VSCodeButtonLink>
					)}
					{apiConfiguration?.openRouterApiKey && apiConfiguration?.apiProvider !== "openrouter" && (
						<VSCodeButton
							onClick={() => {
								vscode.postMessage({
									type: "apiConfiguration",
									apiConfiguration: { ...apiConfiguration, apiProvider: "openrouter" },
								})
							}}
							style={{
								transform: "scale(0.85)",
								transformOrigin: "left center",
								margin: "4px -30px 2px 0",
							}}>
							切换到 OpenRouter
						</VSCodeButton>
					)}
				</li>
				<li>
					<b>在接受之前编辑 Cline 的更改！</b> 当他创建或编辑文件时，您可以直接在差异视图的右侧修改他的更改（+ 将鼠标悬停在中间的“还原块”箭头按钮上以撤消 "<code>{"// rest of code here"}</code>" 的恶作剧）
				</li>
				<li>
					新的 <code>search_files</code> 工具，让 Cline 可以在您的项目中执行正则表达式搜索，从而让他重构代码、处理 TODO 和 FIXME、删除死代码等等！
				</li>
				<li>
					当 Cline 运行命令时，您现在可以直接在终端中输入（+ 支持 Python 环境）
				</li>
			</ul>*/}
			<div
				style={{
					height: "1px",
					background: getAsVar(VSC_DESCRIPTION_FOREGROUND),
					opacity: 0.1,
					margin: "8px 0",
				}}
			/>
			<p style={{ margin: "0" }}>
				在{" "}
				<VSCodeLink style={{ display: "inline" }} href="https://x.com/cline">
					X、
				</VSCodeLink>{" "}
				<VSCodeLink style={{ display: "inline" }} href="https://discord.gg/cline">
					Discord
				</VSCodeLink>{" "}
				或{" "}
				<VSCodeLink style={{ display: "inline" }} href="https://www.reddit.com/r/cline/">
					r/cline
				</VSCodeLink>
				上关注我们以获取更多更新！
			</p>
		</div>
	)
}

export default memo(Announcement)
