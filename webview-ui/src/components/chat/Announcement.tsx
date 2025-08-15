import { VSCodeButton, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { CSSProperties, memo } from "react"
import { getAsVar, VSC_DESCRIPTION_FOREGROUND, VSC_INACTIVE_SELECTION_BACKGROUND } from "@/utils/vscStyles"
import { Accordion, AccordionItem } from "@heroui/react"

interface AnnouncementProps {
	version: string
	hideAnnouncement: () => void
}

const containerStyle: CSSProperties = {
	backgroundColor: getAsVar(VSC_INACTIVE_SELECTION_BACKGROUND),
	borderRadius: "3px",
	padding: "12px 16px",
	margin: "5px 15px 5px 15px",
	position: "relative",
	flexShrink: 0,
}
const closeIconStyle: CSSProperties = { position: "absolute", top: "8px", right: "8px" }
const h3TitleStyle: CSSProperties = { margin: "0 0 8px" }
const ulStyle: CSSProperties = { margin: "0 0 8px", paddingLeft: "12px" }
const accountIconStyle: CSSProperties = { fontSize: 11 }
const hrStyle: CSSProperties = {
	height: "1px",
	background: getAsVar(VSC_DESCRIPTION_FOREGROUND),
	opacity: 0.1,
	margin: "8px 0",
}
const linkContainerStyle: CSSProperties = { margin: "0" }
const linkStyle: CSSProperties = { display: "inline" }

/*
Announcements are automatically shown when the major.minor version changes (for ex 3.19.x → 3.20.x or 4.0.x). 
The latestAnnouncementId is now automatically generated from the extension's package.json version. 
Patch releases (3.19.1 → 3.19.2) will not trigger new announcements.
*/
const Announcement = ({ version, hideAnnouncement }: AnnouncementProps) => {
	const minorVersion = version.split(".").slice(0, 2).join(".") // 2.0.0 -> 2.0
	return (
		<div style={containerStyle}>
			<VSCodeButton data-testid="close-button" appearance="icon" onClick={hideAnnouncement} style={closeIconStyle}>
				<span className="codicon codicon-close"></span>
			</VSCodeButton>
			<h3 style={h3TitleStyle}>
				🎉{"  "}v{minorVersion} 新功能
			</h3>
			<ul style={ulStyle}>
				<li>
					<b>Focus Chain:</b> 通过自动待办事项管理保持cline专注于长期任务，将复杂任务分解为可管理的步骤，具有实时进度跟踪和被动提醒功能。步骤显示在方便的待办事项列表中，可以在任务中途编辑。{" "}
					<VSCodeLink style={linkStyle} href="https://docs.cline.bot/features/focus-chain">
						了解更多
					</VSCodeLink>
				</li>
				<li>
					<b>Auto Compact:</b> 当您的对话接近模型的上下文窗口限制时，自动总结您的任务和下一步。这显著帮助Cline在长时间任务会话中保持正轨！{" "}
					<VSCodeLink style={linkStyle} href="https://docs.cline.bot/features/auto-compact">
						了解更多
					</VSCodeLink>
				</li>
				<li>
					<b>Deep Planning:</b> 新的 <code>/deep-planning</code> 斜杠命令将Cline转变为架构师，在编写任何代码之前，他会调查您的代码库，提出澄清问题，并创建全面的计划。{" "}
					<VSCodeLink style={linkStyle} href="https://docs.cline.bot/features/slash-commands/deep-planning">
						了解更多
					</VSCodeLink>
				</li>
				<li>
					<b>Claude Sonnet 4 的 1M 上下文:</b> Cline/OpenRouter 用户可立即访问，Anthropic 用户需要 Tier 4，Bedrock 用户必须在支持的区域。选择{" "}
					<code>
						claude-sonnet-4<b>:1m</b>
					</code>{" "}
					模型获得 1M 上下文，或使用原始模型获得 200K。
				</li>
			</ul>
			<Accordion isCompact className="pl-0">
				<AccordionItem
					key="1"
					aria-label="之前的更新"
					title="之前的更新:"
					classNames={{
						trigger: "bg-transparent border-0 pl-0 pb-0 w-fit",
						title: "font-bold text-[var(--vscode-foreground)]",
						indicator:
							"text-[var(--vscode-foreground)] mb-0.5 -rotate-180 data-[open=true]:-rotate-90 rtl:rotate-0 rtl:data-[open=true]:-rotate-90",
					}}>
					<ul style={ulStyle}>
						<li>
							<b>Optimized for Claude 4:</b> Cline 现在针对 Claude 4 系列模型进行了优化，提高了性能、可靠性和新功能。
						</li>
						<li>
							<b>Gemini CLI Provider:</b> 添加了新的 Gemini CLI 提供商，允许您使用本地 Gemini CLI 身份验证免费访问 Gemini 模型。
						</li>
						<li>
							<b>WebFetch Tool:</b> Gemini 2.5 Pro 和 Claude 4 模型现在支持 WebFetch 工具，允许 Cline 直接在对话中检索和总结网络内容。
						</li>
						<li>
							<b>Self Knowledge:</b> 使用前沿模型时，Cline 对其功能和特性集有自我认知。
						</li>
						<li>
							<b>Improved Diff Editing:</b> 改进了差异编辑，为前沿模型实现了差异编辑失败的历史新低。
						</li>
						<li>
							<b>Claude 4 Models:</b> 现在在 Anthropic 和 Vertex 提供商中都支持 Anthropic Claude Sonnet 4 和 Claude Opus 4。
						</li>
						<li>
							<b>New Settings Page:</b> 重新设计的设置，现在分为标签页，便于导航和更清洁的体验。
						</li>
						<li>
							<b>Nebius AI Studio:</b> 添加 Nebius AI Studio 作为新的提供商。（感谢 @Aktsvigun！）
						</li>
						<li>
							<b>Workflows:</b> 创建和管理工作流文件，可以通过斜杠命令注入到对话中，轻松自动化重复任务。
						</li>
						<li>
							<b>Collapsible Task List:</b> 在共享屏幕时隐藏您的最近任务，保持您的提示私密。
						</li>
						<li>
							<b>Global Endpoint for Vertex AI:</b> 为 Vertex AI 用户提高了可用性并减少了速率限制错误。
						</li>
					</ul>
				</AccordionItem>
			</Accordion>
			<div style={hrStyle} />
			<p style={linkContainerStyle}>
				在{" "}
				<VSCodeLink style={linkStyle} href="https://x.com/cline">
					X,
				</VSCodeLink>{" "}
				<VSCodeLink style={linkStyle} href="https://discord.gg/cline">
					discord,
				</VSCodeLink>{" "}
				或{" "}
				<VSCodeLink style={linkStyle} href="https://www.reddit.com/r/cline/">
					r/cline
				</VSCodeLink>
				上加入我们，获取更多更新！
			</p>
		</div>
	)
}

export default memo(Announcement)
