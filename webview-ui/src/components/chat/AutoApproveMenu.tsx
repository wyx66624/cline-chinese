import { VSCodeCheckbox, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useState } from "react"
import styled from "styled-components"
import { useExtensionState } from "../../context/ExtensionStateContext"
import { AutoApprovalSettings } from "../../../../src/shared/AutoApprovalSettings"
import { vscode } from "../../utils/vscode"
import { getAsVar, VSC_FOREGROUND, VSC_TITLEBAR_INACTIVE_FOREGROUND, VSC_DESCRIPTION_FOREGROUND } from "../../utils/vscStyles"

interface AutoApproveMenuProps {
	style?: React.CSSProperties
}

const ACTION_METADATA: {
	id: keyof AutoApprovalSettings["actions"]
	label: string
	shortName: string
	description: string
}[] = [
	{
		id: "readFiles",
		label: "读取文件和目录",
		shortName: "读取",
		description: "允许访问读取您计算机上的任何文件。",
	},
	{
		id: "editFiles",
		label: "编辑文件",
		shortName: "编辑",
		description: "允许修改您计算机上的任何文件。",
	},
	{
		id: "executeCommands",
		label: "执行安全命令",
		shortName: "命令",
		description: "允许执行安全的终端命令。如果模型确定某个命令具有潜在破坏性，则仍需要批准。",
	},
	{
		id: "useBrowser",
		label: "使用浏览器",
		shortName: "浏览器",
		description: "允许在无头浏览器中启动任何网站并与之交互。",
	},
	{
		id: "useMcp",
		label: "使用 MCP 服务器",
		shortName: "MCP",
		description: "允许使用已配置的 MCP 服务器，这些服务器可能会修改文件系统或与 API 交互。",
	},
]

const AutoApproveMenu = ({ style }: AutoApproveMenuProps) => {
	const { autoApprovalSettings } = useExtensionState()
	const [isExpanded, setIsExpanded] = useState(false)
	const [isHoveringCollapsibleSection, setIsHoveringCollapsibleSection] = useState(false)

	// 注意不要使用部分更新来修改状态，因为扩展运算符只进行浅拷贝

	const enabledActions = ACTION_METADATA.filter((action) => autoApprovalSettings.actions[action.id])
	const enabledActionsList = enabledActions.map((action) => action.shortName).join(", ")
	const hasEnabledActions = enabledActions.length > 0

	const updateEnabled = useCallback(
		(enabled: boolean) => {
			vscode.postMessage({
				type: "autoApprovalSettings",
				autoApprovalSettings: {
					...autoApprovalSettings,
					enabled,
				},
			})
		},
		[autoApprovalSettings],
	)

	const updateAction = useCallback(
		(actionId: keyof AutoApprovalSettings["actions"], value: boolean) => {
			// 计算新的 actions 状态
			const newActions = {
				...autoApprovalSettings.actions,
				[actionId]: value,
			}

			// 检查这是否会导致任何操作被启用
			const willHaveEnabledActions = Object.values(newActions).some(Boolean)

			vscode.postMessage({
				type: "autoApprovalSettings",
				autoApprovalSettings: {
					...autoApprovalSettings,
					actions: newActions,
					// 如果没有操作将被启用，确保主开关关闭
					enabled: willHaveEnabledActions ? autoApprovalSettings.enabled : false,
				},
			})
		},
		[autoApprovalSettings],
	)

	const updateMaxRequests = useCallback(
		(maxRequests: number) => {
			vscode.postMessage({
				type: "autoApprovalSettings",
				autoApprovalSettings: {
					...autoApprovalSettings,
					maxRequests,
				},
			})
		},
		[autoApprovalSettings],
	)

	const updateNotifications = useCallback(
		(enableNotifications: boolean) => {
			vscode.postMessage({
				type: "autoApprovalSettings",
				autoApprovalSettings: {
					...autoApprovalSettings,
					enableNotifications,
				},
			})
		},
		[autoApprovalSettings],
	)

	return (
		<div
			style={{
				padding: "0 15px",
				userSelect: "none",
				borderTop: isExpanded
					? `0.5px solid color-mix(in srgb, ${getAsVar(VSC_TITLEBAR_INACTIVE_FOREGROUND)} 20%, transparent)`
					: "none",
				overflowY: "auto",
				...style,
			}}>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: "8px",
					padding: isExpanded ? "8px 0" : "8px 0 0 0",
					cursor: !hasEnabledActions ? "pointer" : "default",
				}}
				onMouseEnter={() => {
					if (!hasEnabledActions) {
						setIsHoveringCollapsibleSection(true)
					}
				}}
				onMouseLeave={() => {
					if (!hasEnabledActions) {
						setIsHoveringCollapsibleSection(false)
					}
				}}
				onClick={() => {
					if (!hasEnabledActions) {
						setIsExpanded((prev) => !prev)
					}
				}}>
				<VSCodeCheckbox
					style={{
						pointerEvents: hasEnabledActions ? "auto" : "none",
					}}
					checked={hasEnabledActions && autoApprovalSettings.enabled}
					disabled={!hasEnabledActions}
					// onChange={(e) => {
					// 	const checked = (e.target as HTMLInputElement).checked
					// 	updateEnabled(checked)
					// }}
					onClick={(e) => {
						/*
						vscode web toolkit 错误：当以编程方式更改 vscodecheckbox 的值时，它会使用过时的状态调用其 onChange。这导致 updateEnabled 使用旧版本的 autoApprovalSettings 被调用，有效地撤销了由取消选中最后一个操作触发的状态更改。一个简单的解决方法是不使用 onChange，而是使用 onClick。幸运的是，这是一个复选框，新值只是当前状态的相反值。
						*/
						if (!hasEnabledActions) return
						e.stopPropagation() // 阻止点击事件冒泡到父元素，在这种情况下阻止展开/折叠
						updateEnabled(!autoApprovalSettings.enabled)
					}}
				/>
				<CollapsibleSection
					isHovered={isHoveringCollapsibleSection}
					style={{ cursor: "pointer" }}
					onClick={() => {
						// 防止与父元素的点击事件冲突
						if (hasEnabledActions) {
							setIsExpanded((prev) => !prev)
						}
					}}>
					<span
						style={{
							color: getAsVar(VSC_FOREGROUND),
							whiteSpace: "nowrap",
						}}>
						自动批准：
					</span>
					<span
						style={{
							whiteSpace: "nowrap",
							overflow: "hidden",
							textOverflow: "ellipsis",
						}}>
						{enabledActions.length === 0 ? "无" : enabledActionsList}
					</span>
					<span
						className={`codicon codicon-chevron-${isExpanded ? "down" : "right"}`}
						style={{
							flexShrink: 0,
							marginLeft: isExpanded ? "2px" : "-2px",
						}}
					/>
				</CollapsibleSection>
			</div>
			{isExpanded && (
				<div style={{ padding: "0" }}>
					<div
						style={{
							marginBottom: "10px",
							color: getAsVar(VSC_DESCRIPTION_FOREGROUND),
							fontSize: "12px",
						}}>
						自动批准允许 Cline 在不征求许可的情况下执行以下操作。请谨慎使用，并仅在了解风险的情况下启用。
					</div>
					{ACTION_METADATA.map((action) => (
						<div key={action.id} style={{ margin: "6px 0" }}>
							<VSCodeCheckbox
								checked={autoApprovalSettings.actions[action.id]}
								onChange={(e) => {
									const checked = (e.target as HTMLInputElement).checked
									updateAction(action.id, checked)
								}}>
								{action.label}
							</VSCodeCheckbox>
							<div
								style={{
									marginLeft: "28px",
									color: getAsVar(VSC_DESCRIPTION_FOREGROUND),
									fontSize: "12px",
								}}>
								{action.description}
							</div>
						</div>
					))}
					<div
						style={{
							height: "0.5px",
							background: getAsVar(VSC_TITLEBAR_INACTIVE_FOREGROUND),
							margin: "15px 0",
							opacity: 0.2,
						}}
					/>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: "8px",
							marginTop: "10px",
							marginBottom: "8px",
							color: getAsVar(VSC_FOREGROUND),
						}}>
						<span style={{ flexShrink: 1, minWidth: 0 }}>最大请求数：</span>
						<VSCodeTextField
							// placeholder={DEFAULT_AUTO_APPROVAL_SETTINGS.maxRequests.toString()}
							value={autoApprovalSettings.maxRequests.toString()}
							onInput={(e) => {
								const input = e.target as HTMLInputElement
								// 移除所有非数字字符
								input.value = input.value.replace(/[^0-9]/g, "")
								const value = parseInt(input.value)
								if (!isNaN(value) && value > 0) {
									updateMaxRequests(value)
								}
							}}
							onKeyDown={(e) => {
								// 阻止非数字键（退格键、删除键、箭头键除外）
								if (!/^\d$/.test(e.key) && !["Backspace", "Delete", "ArrowLeft", "ArrowRight"].includes(e.key)) {
									e.preventDefault()
								}
							}}
							style={{ flex: 1 }}
						/>
					</div>
					<div
						style={{
							color: getAsVar(VSC_DESCRIPTION_FOREGROUND),
							fontSize: "12px",
							marginBottom: "10px",
						}}>
						Cline 将自动发出这么多次 API 请求，然后才请求批准以继续执行任务。
					</div>
					<div style={{ margin: "6px 0" }}>
						<VSCodeCheckbox
							checked={autoApprovalSettings.enableNotifications}
							onChange={(e) => {
								const checked = (e.target as HTMLInputElement).checked
								updateNotifications(checked)
							}}>
							启用通知
						</VSCodeCheckbox>
						<div
							style={{
								marginLeft: "28px",
								color: getAsVar(VSC_DESCRIPTION_FOREGROUND),
								fontSize: "12px",
							}}>
							当 Cline 需要批准才能继续或任务完成时接收系统通知。
						</div>
					</div>
				</div>
			)}
		</div>
	)
}

const CollapsibleSection = styled.div<{ isHovered?: boolean }>`
	display: flex;
	align-items: center;
	gap: 4px;
	color: ${(props) => (props.isHovered ? getAsVar(VSC_FOREGROUND) : getAsVar(VSC_DESCRIPTION_FOREGROUND))};
	flex: 1;
	min-width: 0;

	&:hover {
		color: ${getAsVar(VSC_FOREGROUND)};
	}
`

export default AutoApproveMenu
