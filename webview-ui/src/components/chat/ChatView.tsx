import { VSCodeButton, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import debounce from "debounce"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useDeepCompareEffect, useEvent, useMount } from "react-use"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
import styled from "styled-components"
import {
	ClineApiReqInfo,
	ClineAsk,
	ClineMessage,
	ClineSayBrowserAction,
	ClineSayTool,
	ExtensionMessage,
} from "../../../../src/shared/ExtensionMessage"
import { findLast } from "../../../../src/shared/array"
import { combineApiRequests } from "../../../../src/shared/combineApiRequests"
import { combineCommandSequences } from "../../../../src/shared/combineCommandSequences"
import { getApiMetrics } from "../../../../src/shared/getApiMetrics"
import { useExtensionState } from "../../context/ExtensionStateContext"
import { vscode } from "../../utils/vscode"
import HistoryPreview from "../history/HistoryPreview"
import { normalizeApiConfiguration } from "../settings/ApiOptions"
import Announcement from "./Announcement"
import AutoApproveMenu from "./AutoApproveMenu"
import BrowserSessionRow from "./BrowserSessionRow"
import ChatRow from "./ChatRow"
import ChatTextArea from "./ChatTextArea"
import TaskHeader from "./TaskHeader"
import TelemetryBanner from "../common/TelemetryBanner"

interface ChatViewProps {
	isHidden: boolean
	showAnnouncement: boolean
	hideAnnouncement: () => void
	showHistoryView: () => void
}

export const MAX_IMAGES_PER_MESSAGE = 20 // Anthropic limits to 20 images

const ChatView = ({ isHidden, showAnnouncement, hideAnnouncement, showHistoryView }: ChatViewProps) => {
	const { version, clineMessages: messages, taskHistory, apiConfiguration, telemetrySetting } = useExtensionState()

	//const task = messages.length > 0 ? (messages[0].say === "task" ? messages[0] : undefined) : undefined) : undefined
	const task = useMemo(() => messages.at(0), [messages]) // leaving this less safe version here since if the first message is not a task, then the extension is in a bad state and needs to be debugged (see Cline.abort)
	const modifiedMessages = useMemo(() => combineApiRequests(combineCommandSequences(messages.slice(1))), [messages])
	// has to be after api_req_finished are all reduced into api_req_started messages
	const apiMetrics = useMemo(() => getApiMetrics(modifiedMessages), [modifiedMessages])

	const lastApiReqTotalTokens = useMemo(() => {
		const getTotalTokensFromApiReqMessage = (msg: ClineMessage) => {
			if (!msg.text) return 0
			const { tokensIn, tokensOut, cacheWrites, cacheReads }: ClineApiReqInfo = JSON.parse(msg.text)
			return (tokensIn || 0) + (tokensOut || 0) + (cacheWrites || 0) + (cacheReads || 0)
		}
		const lastApiReqMessage = findLast(modifiedMessages, (msg) => {
			if (msg.say !== "api_req_started") return false
			return getTotalTokensFromApiReqMessage(msg) > 0
		})
		if (!lastApiReqMessage) return undefined
		return getTotalTokensFromApiReqMessage(lastApiReqMessage)
	}, [modifiedMessages])

	const [inputValue, setInputValue] = useState("")
	const textAreaRef = useRef<HTMLTextAreaElement>(null)
	const [textAreaDisabled, setTextAreaDisabled] = useState(false)
	const [selectedImages, setSelectedImages] = useState<string[]>([])

	// we need to hold on to the ask because useEffect > lastMessage will always let us know when an ask comes in and handle it, but by the time handleMessage is called, the last message might not be the ask anymore (it could be a say that followed)
	const [clineAsk, setClineAsk] = useState<ClineAsk | undefined>(undefined)
	const [enableButtons, setEnableButtons] = useState<boolean>(false)
	const [primaryButtonText, setPrimaryButtonText] = useState<string | undefined>("Approve")
	const [secondaryButtonText, setSecondaryButtonText] = useState<string | undefined>("Reject")
	const [didClickCancel, setDidClickCancel] = useState(false)
	const virtuosoRef = useRef<VirtuosoHandle>(null)
	const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({})
	const scrollContainerRef = useRef<HTMLDivElement>(null)
	const disableAutoScrollRef = useRef(false)
	const [showScrollToBottom, setShowScrollToBottom] = useState(false)
	const [isAtBottom, setIsAtBottom] = useState(false)

	// UI layout depends on the last 2 messages
	// (since it relies on the content of these messages, we are deep comparing. i.e. the button state after hitting button sets enableButtons to false, and this effect otherwise would have to true again even if messages didn't change
	const lastMessage = useMemo(() => messages.at(-1), [messages])
	const secondLastMessage = useMemo(() => messages.at(-2), [messages])
	useDeepCompareEffect(() => {
		// if last message is an ask, show user ask UI
		// if user finished a task, then start a new task with a new conversation history since in this moment that the extension is waiting for user response, the user could close the extension and the conversation history would be lost.
		// basically as long as a task is active, the conversation history will be persisted
		if (lastMessage) {
			switch (lastMessage.type) {
				case "ask":
					const isPartial = lastMessage.partial === true
					switch (lastMessage.ask) {
						case "api_req_failed":
							setTextAreaDisabled(true)
							setClineAsk("api_req_failed")
							setEnableButtons(true)
							setPrimaryButtonText("Retry")
							setSecondaryButtonText("Start New Task")
							break
						case "mistake_limit_reached":
							setTextAreaDisabled(false)
							setClineAsk("mistake_limit_reached")
							setEnableButtons(true)
							setPrimaryButtonText("Proceed Anyways")
							setSecondaryButtonText("Start New Task")
							break
						case "auto_approval_max_req_reached":
							setTextAreaDisabled(true)
							setClineAsk("auto_approval_max_req_reached")
							setEnableButtons(true)
							setPrimaryButtonText("Proceed")
							setSecondaryButtonText("Start New Task")
							break
						case "followup":
							setTextAreaDisabled(isPartial)
							setClineAsk("followup")
							setEnableButtons(false)
							// setPrimaryButtonText(undefined)
							// setSecondaryButtonText(undefined)
							break
						case "plan_mode_respond":
							setTextAreaDisabled(isPartial)
							setClineAsk("plan_mode_respond")
							setEnableButtons(false)
							// setPrimaryButtonText(undefined)
							// setSecondaryButtonText(undefined)
							break
						case "tool":
							setTextAreaDisabled(isPartial)
							setClineAsk("tool")
							setEnableButtons(!isPartial)
							const tool = JSON.parse(lastMessage.text || "{}") as ClineSayTool
							switch (tool.tool) {
								case "editedExistingFile":
								case "newFileCreated":
									setPrimaryButtonText("Save")
									setSecondaryButtonText("Reject")
									break
								default:
									setPrimaryButtonText("Approve")
									setSecondaryButtonText("Reject")
									break
							}
							break
						case "browser_action_launch":
							setTextAreaDisabled(isPartial)
							setClineAsk("browser_action_launch")
							setEnableButtons(!isPartial)
							setPrimaryButtonText("Approve")
							setSecondaryButtonText("Reject")
							break
						case "command":
							setTextAreaDisabled(isPartial)
							setClineAsk("command")
							setEnableButtons(!isPartial)
							setPrimaryButtonText("Run Command")
							setSecondaryButtonText("Reject")
							break
						case "command_output":
							setTextAreaDisabled(false)
							setClineAsk("command_output")
							setEnableButtons(true)
							setPrimaryButtonText("Proceed While Running")
							setSecondaryButtonText(undefined)
							break
						case "use_mcp_server":
							setTextAreaDisabled(isPartial)
							setClineAsk("use_mcp_server")
							setEnableButtons(!isPartial)
							setPrimaryButtonText("Approve")
							setSecondaryButtonText("Reject")
							break
						case "completion_result":
							// extension waiting for feedback. but we can just present a new task button
							setTextAreaDisabled(isPartial)
							setClineAsk("completion_result")
							setEnableButtons(!isPartial)
							setPrimaryButtonText("Start New Task")
							setSecondaryButtonText(undefined)
							break
						case "resume_task":
							setTextAreaDisabled(false)
							setClineAsk("resume_task")
							setEnableButtons(true)
							setPrimaryButtonText("Resume Task")
							setSecondaryButtonText(undefined)
							setDidClickCancel(false) // special case where we reset the cancel button state
							break
						case "resume_completed_task":
							setTextAreaDisabled(false)
							setClineAsk("resume_completed_task")
							setEnableButtons(true)
							setPrimaryButtonText("Start New Task")
							setSecondaryButtonText(undefined)
							setDidClickCancel(false)
							break
					}
					break
				case "say":
					// don't want to reset since there could be a "say" after an "ask" while ask is waiting for response
					switch (lastMessage.say) {
						case "api_req_started":
							if (secondLastMessage?.ask === "command_output") {
								// if the last ask is a command_output, and we receive an api_req_started, then that means the command has finished and we don't need input from the user anymore (in every other case, the user has to interact with input field or buttons to continue, which does the following automatically)
								setInputValue("")
								setTextAreaDisabled(true)
								setSelectedImages([])
								setClineAsk(undefined)
								setEnableButtons(false)
							}
							break
						case "task":
						case "error":
						case "api_req_finished":
						case "text":
						case "browser_action":
						case "browser_action_result":
						case "browser_action_launch":
						case "command":
						case "use_mcp_server":
						case "command_output":
						case "mcp_server_request_started":
						case "mcp_server_response":
						case "completion_result":
						case "tool":
							break
					}
					break
			}
		} else {
			// this would get called after sending the first message, so we have to watch messages.length instead
			// No messages, so user has to submit a task
			// setTextAreaDisabled(false)
			// setClineAsk(undefined)
			// setPrimaryButtonText(undefined)
			// setSecondaryButtonText(undefined)
		}
	}, [lastMessage, secondLastMessage])

	useEffect(() => {
		if (messages.length === 0) {
			setTextAreaDisabled(false)
			setClineAsk(undefined)
			setEnableButtons(false)
			setPrimaryButtonText("Approve")
			setSecondaryButtonText("Reject")
		}
	}, [messages.length])

	useEffect(() => {
		setExpandedRows({})
	}, [task?.ts])

	const isStreaming = useMemo(() => {
		const isLastAsk = !!modifiedMessages.at(-1)?.ask // checking clineAsk isn't enough since messages effect may be called again for a tool for example, set clineAsk to its value, and if the next message is not an ask then it doesn't reset. This is likely due to how much more often we're updating messages as compared to before, and should be resolved with optimizations as it's likely a rendering bug. but as a final guard for now, the cancel button will show if the last message is not an ask
		const isToolCurrentlyAsking = isLastAsk && clineAsk !== undefined && enableButtons && primaryButtonText !== undefined
		if (isToolCurrentlyAsking) {
			return false
		}

		const isLastMessagePartial = modifiedMessages.at(-1)?.partial === true
		if (isLastMessagePartial) {
			return true
		} else {
			const lastApiReqStarted = findLast(modifiedMessages, (message) => message.say === "api_req_started")
			if (lastApiReqStarted && lastApiReqStarted.text != null && lastApiReqStarted.say === "api_req_started") {
				const cost = JSON.parse(lastApiReqStarted.text).cost
				if (cost === undefined) {
					// api request has not finished yet
					return true
				}
			}
		}

		return false
	}, [modifiedMessages, clineAsk, enableButtons, primaryButtonText])

	const handleSendMessage = useCallback(
		(text: string, images: string[]) => {
			text = text.trim()
			if (text || images.length > 0) {
				if (messages.length === 0) {
					vscode.postMessage({ type: "newTask", text, images })
				} else if (clineAsk) {
					switch (clineAsk) {
						case "followup":
						case "plan_mode_respond":
						case "tool":
						case "browser_action_launch":
						case "command": // user can provide feedback to a tool or command use
						case "command_output": // user can send input to command stdin
						case "use_mcp_server":
						case "completion_result": // if this happens then the user has feedback for the completion result
						case "resume_task":
						case "resume_completed_task":
						case "mistake_limit_reached":
							vscode.postMessage({
								type: "askResponse",
								askResponse: "messageResponse",
								text,
								images,
							})
							break
						// there is no other case that a textfield should be enabled
					}
				}
				setInputValue("")
				setTextAreaDisabled(true)
				setSelectedImages([])
				setClineAsk(undefined)
				setEnableButtons(false)
				// setPrimaryButtonText(undefined)
				// setSecondaryButtonText(undefined)
				disableAutoScrollRef.current = false
			}
		},
		[messages.length, clineAsk],
	)

	const startNewTask = useCallback(() => {
		vscode.postMessage({ type: "clearTask" })
	}, [])

	/*
	This logic depends on the useEffect[messages] above to set clineAsk, after which buttons are shown and we then send an askResponse to the extension.
	*/
	const handlePrimaryButtonClick = useCallback(
		(text?: string, images?: string[]) => {
			const trimmedInput = text?.trim()
			switch (clineAsk) {
				case "api_req_failed":
				case "command":
				case "command_output":
				case "tool":
				case "browser_action_launch":
				case "use_mcp_server":
				case "resume_task":
				case "mistake_limit_reached":
				case "auto_approval_max_req_reached":
					if (trimmedInput || (images && images.length > 0)) {
						vscode.postMessage({
							type: "askResponse",
							askResponse: "yesButtonClicked",
							text: trimmedInput,
							images: images,
						})
					} else {
						vscode.postMessage({
							type: "askResponse",
							askResponse: "yesButtonClicked",
						})
					}
					// Clear input state after sending
					setInputValue("")
					setSelectedImages([])
					break
				case "completion_result":
				case "resume_completed_task":
					// extension waiting for feedback. but we can just present a new task button
					startNewTask()
					break
			}
			setTextAreaDisabled(true)
			setClineAsk(undefined)
			setEnableButtons(false)
			// setPrimaryButtonText(undefined)
			// setSecondaryButtonText(undefined)
			disableAutoScrollRef.current = false
		},
		[clineAsk, startNewTask],
	)

	const handleSecondaryButtonClick = useCallback(
		(text?: string, images?: string[]) => {
			const trimmedInput = text?.trim()
			if (isStreaming) {
				vscode.postMessage({ type: "cancelTask" })
				setDidClickCancel(true)
				return
			}

			switch (clineAsk) {
				case "api_req_failed":
				case "mistake_limit_reached":
				case "auto_approval_max_req_reached":
					startNewTask()
					break
				case "command":
				case "tool":
				case "browser_action_launch":
				case "use_mcp_server":
					if (trimmedInput || (images && images.length > 0)) {
						vscode.postMessage({
							type: "askResponse",
							askResponse: "noButtonClicked",
							text: trimmedInput,
							images: images,
						})
					} else {
						// responds to the API with a "This operation failed" and lets it try again
						vscode.postMessage({
							type: "askResponse",
							askResponse: "noButtonClicked",
						})
					}
					// Clear input state after sending
					setInputValue("")
					setSelectedImages([])
					break
			}
			setTextAreaDisabled(true)
			setClineAsk(undefined)
			setEnableButtons(false)
			// setPrimaryButtonText(undefined)
			// setSecondaryButtonText(undefined)
			disableAutoScrollRef.current = false
		},
		[clineAsk, startNewTask, isStreaming],
	)

	const handleTaskCloseButtonClick = useCallback(() => {
		startNewTask()
	}, [startNewTask])

	const { selectedModelInfo } = useMemo(() => {
		return normalizeApiConfiguration(apiConfiguration)
	}, [apiConfiguration])

	const selectImages = useCallback(() => {
		vscode.postMessage({ type: "selectImages" })
	}, [])

	const shouldDisableImages =
		!selectedModelInfo.supportsImages || textAreaDisabled || selectedImages.length >= MAX_IMAGES_PER_MESSAGE

	const handleMessage = useCallback(
		(e: MessageEvent) => {
			const message: ExtensionMessage = e.data
			switch (message.type) {
				case "action":
					switch (message.action!) {
						case "didBecomeVisible":
							if (!isHidden && !textAreaDisabled && !enableButtons) {
								textAreaRef.current?.focus()
							}
							break
					}
					break
				case "selectedImages":
					const newImages = message.images ?? []
					if (newImages.length > 0) {
						setSelectedImages((prevImages) => [...prevImages, ...newImages].slice(0, MAX_IMAGES_PER_MESSAGE))
					}
					break
				case "addToInput":
					setInputValue((prevValue) => {
						const newText = message.text ?? ""
						return prevValue ? `${prevValue}\n${newText}` : newText
					})
					// Add scroll to bottom after state update
					setTimeout(() => {
						if (textAreaRef.current) {
							textAreaRef.current.scrollTop = textAreaRef.current.scrollHeight
						}
					}, 0)
					break
				case "invoke":
					switch (message.invoke!) {
						case "sendMessage":
							handleSendMessage(message.text ?? "", message.images ?? [])
							break
						case "primaryButtonClick":
							handlePrimaryButtonClick(message.text ?? "", message.images ?? [])
							break
						case "secondaryButtonClick":
							handleSecondaryButtonClick(message.text ?? "", message.images ?? [])
							break
					}
			}
			// textAreaRef.current is not explicitly required here since react guarantees that ref will be stable across re-renders, and we're not using its value but its reference.
		},
		[isHidden, textAreaDisabled, enableButtons, handleSendMessage, handlePrimaryButtonClick, handleSecondaryButtonClick],
	)

	useEvent("message", handleMessage)

	useMount(() => {
		// NOTE: the vscode window needs to be focused for this to work
		textAreaRef.current?.focus()
	})

	useEffect(() => {
		const timer = setTimeout(() => {
			if (!isHidden && !textAreaDisabled && !enableButtons) {
				textAreaRef.current?.focus()
			}
		}, 50)
		return () => {
			clearTimeout(timer)
		}
	}, [isHidden, textAreaDisabled, enableButtons])

	const visibleMessages = useMemo(() => {
		return modifiedMessages.filter((message) => {
			switch (message.ask) {
				case "completion_result":
					// don't show a chat row for a completion_result ask without text. This specific type of message only occurs if cline wants to execute a command as part of its completion result, in which case we interject the completion_result tool with the execute_command tool.
					if (message.text === "") {
						return false
					}
					break
				case "api_req_failed": // this message is used to update the latest api_req_started that the request failed
				case "resume_task":
				case "resume_completed_task":
					return false
			}
			switch (message.say) {
				case "api_req_finished": // combineApiRequests removes this from modifiedMessages anyways
				case "api_req_retried": // this message is used to update the latest api_req_started that the request was retried
				case "deleted_api_reqs": // aggregated api_req metrics from deleted messages
					return false
				case "text":
					// Sometimes cline returns an empty text message, we don't want to render these. (We also use a say text for user messages, so in case they just sent images we still render that)
					if ((message.text ?? "") === "" && (message.images?.length ?? 0) === 0) {
						return false
					}
					break
				case "mcp_server_request_started":
					return false
			}
			return true
		})
	}, [modifiedMessages])

	const isBrowserSessionMessage = (message: ClineMessage): boolean => {
		// which of visible messages are browser session messages, see above
		if (message.type === "ask") {
			return ["browser_action_launch"].includes(message.ask!)
		}
		if (message.type === "say") {
			return ["browser_action_launch", "api_req_started", "text", "browser_action", "browser_action_result"].includes(
				message.say!,
			)
		}
		return false
	}

	const groupedMessages = useMemo(() => {
		const result: (ClineMessage | ClineMessage[])[] = []
		let currentGroup: ClineMessage[] = []
		let isInBrowserSession = false

		const endBrowserSession = () => {
			if (currentGroup.length > 0) {
				result.push([...currentGroup])
				currentGroup = []
				isInBrowserSession = false
			}
		}

		visibleMessages.forEach((message) => {
			if (message.ask === "browser_action_launch" || message.say === "browser_action_launch") {
				// complete existing browser session if any
				endBrowserSession()
				// start new
				isInBrowserSession = true
				currentGroup.push(message)
			} else if (isInBrowserSession) {
				// end session if api_req_started is cancelled

				if (message.say === "api_req_started") {
					// get last api_req_started in currentGroup to check if it's cancelled. If it is then this api req is not part of the current browser session
					const lastApiReqStarted = [...currentGroup].reverse().find((m) => m.say === "api_req_started")
					if (lastApiReqStarted?.text != null) {
						const info = JSON.parse(lastApiReqStarted.text)
						const isCancelled = info.cancelReason != null
						if (isCancelled) {
							endBrowserSession()
							result.push(message)
							return
						}
					}
				}

				if (isBrowserSessionMessage(message)) {
					currentGroup.push(message)

					// Check if this is a close action
					if (message.say === "browser_action") {
						const browserAction = JSON.parse(message.text || "{}") as ClineSayBrowserAction
						if (browserAction.action === "close") {
							endBrowserSession()
						}
					}
				} else {
					// complete existing browser session if any
					endBrowserSession()
					result.push(message)
				}
			} else {
				result.push(message)
			}
		})

		// Handle case where browser session is the last group
		if (currentGroup.length > 0) {
			result.push([...currentGroup])
		}

		return result
	}, [visibleMessages])

	// scrolling

	const scrollToBottomSmooth = useMemo(
		() =>
			debounce(
				() => {
					virtuosoRef.current?.scrollTo({
						top: Number.MAX_SAFE_INTEGER,
						behavior: "smooth",
					})
				},
				10,
				{ immediate: true },
			),
		[],
	)

	const scrollToBottomAuto = useCallback(() => {
		virtuosoRef.current?.scrollTo({
			top: Number.MAX_SAFE_INTEGER,
			behavior: "auto", // instant causes crash
		})
	}, [])

	// scroll when user toggles certain rows
	const toggleRowExpansion = useCallback(
		(ts: number) => {
			const isCollapsing = expandedRows[ts] ?? false
			const lastGroup = groupedMessages.at(-1)
			const isLast = Array.isArray(lastGroup) ? lastGroup[0].ts === ts : lastGroup?.ts === ts
			const secondToLastGroup = groupedMessages.at(-2)
			const isSecondToLast = Array.isArray(secondToLastGroup)
				? secondToLastGroup[0].ts === ts
				: secondToLastGroup?.ts === ts

			const isLastCollapsedApiReq =
				isLast &&
				!Array.isArray(lastGroup) && // Make sure it's not a browser session group
				lastGroup?.say === "api_req_started" &&
				!expandedRows[lastGroup.ts]

			setExpandedRows((prev) => ({
				...prev,
				[ts]: !prev[ts],
			}))

			// disable auto scroll when user expands row
			if (!isCollapsing) {
				disableAutoScrollRef.current = true
			}

			if (isCollapsing && isAtBottom) {
				const timer = setTimeout(() => {
					scrollToBottomAuto()
				}, 0)
				return () => clearTimeout(timer)
			} else if (isLast || isSecondToLast) {
				if (isCollapsing) {
					if (isSecondToLast && !isLastCollapsedApiReq) {
						return
					}
					const timer = setTimeout(() => {
						scrollToBottomAuto()
					}, 0)
					return () => clearTimeout(timer)
				} else {
					const timer = setTimeout(() => {
						virtuosoRef.current?.scrollToIndex({
							index: groupedMessages.length - (isLast ? 1 : 2),
							align: "start",
						})
					}, 0)
					return () => clearTimeout(timer)
				}
			}
		},
		[groupedMessages, expandedRows, scrollToBottomAuto, isAtBottom],
	)

	const handleRowHeightChange = useCallback(
		(isTaller: boolean) => {
			if (!disableAutoScrollRef.current) {
				if (isTaller) {
					scrollToBottomSmooth()
				} else {
					setTimeout(() => {
						scrollToBottomAuto()
					}, 0)
				}
			}
		},
		[scrollToBottomSmooth, scrollToBottomAuto],
	)

	useEffect(() => {
		if (!disableAutoScrollRef.current) {
			setTimeout(() => {
				scrollToBottomSmooth()
			}, 50)
			// return () => clearTimeout(timer) // dont cleanup since if visibleMessages.length changes it cancels.
		}
	}, [groupedMessages.length, scrollToBottomSmooth])

	const handleWheel = useCallback((event: Event) => {
		const wheelEvent = event as WheelEvent
		if (wheelEvent.deltaY && wheelEvent.deltaY < 0) {
			if (scrollContainerRef.current?.contains(wheelEvent.target as Node)) {
				// 用户向上滚动
				disableAutoScrollRef.current = true
			}
		}
	}, [])
	useEvent("wheel", handleWheel, window, { passive: true }) // passive 提高滚动性能

	const placeholderText = useMemo(() => {
		const text = task ? "输入消息..." : "在这里输入你的任务..."
		return text
	}, [task])

	const itemContent = useCallback(
		(index: number, messageOrGroup: ClineMessage | ClineMessage[]) => {
			// 浏览器会话组
			if (Array.isArray(messageOrGroup)) {
				return (
					<BrowserSessionRow
						messages={messageOrGroup}
						isLast={index === groupedMessages.length - 1}
						lastModifiedMessage={modifiedMessages.at(-1)}
						onHeightChange={handleRowHeightChange}
						// 为组中的每条消息传递处理程序
						isExpanded={(messageTs: number) => expandedRows[messageTs] ?? false}
						onToggleExpand={(messageTs: number) => {
							setExpandedRows((prev) => ({
								...prev,
								[messageTs]: !prev[messageTs],
							}))
						}}
					/>
				)
			}

			// 常规消息
			return (
				<ChatRow
					key={messageOrGroup.ts}
					message={messageOrGroup}
					isExpanded={expandedRows[messageOrGroup.ts] || false}
					onToggleExpand={() => toggleRowExpansion(messageOrGroup.ts)}
					lastModifiedMessage={modifiedMessages.at(-1)}
					isLast={index === groupedMessages.length - 1}
					onHeightChange={handleRowHeightChange}
				/>
			)
		},
		[expandedRows, modifiedMessages, groupedMessages.length, toggleRowExpansion, handleRowHeightChange],
	)

	return (
		<div
			style={{
				position: "fixed",
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				display: isHidden ? "none" : "flex",
				flexDirection: "column",
				overflow: "hidden",
			}}>
			{task ? (
				<TaskHeader
					task={task}
					tokensIn={apiMetrics.totalTokensIn}
					tokensOut={apiMetrics.totalTokensOut}
					doesModelSupportPromptCache={selectedModelInfo.supportsPromptCache}
					cacheWrites={apiMetrics.totalCacheWrites}
					cacheReads={apiMetrics.totalCacheReads}
					totalCost={apiMetrics.totalCost}
					lastApiReqTotalTokens={lastApiReqTotalTokens}
					onClose={handleTaskCloseButtonClick}
				/>
			) : (
				<div
					style={{
						flex: "1 1 0", // flex-grow: 1, flex-shrink: 1, flex-basis: 0
						minHeight: 0,
						overflowY: "auto",
						display: "flex",
						flexDirection: "column",
						paddingBottom: "10px",
					}}>
					{telemetrySetting === "unset" && <TelemetryBanner />}

					{showAnnouncement && <Announcement version={version} hideAnnouncement={hideAnnouncement} />}

					<div style={{ padding: "0 20px", flexShrink: 0 }}>
						<h2>我能为你做些什么？</h2>
						<p>
							感谢{" "}
							<VSCodeLink href="https://www.anthropic.com/claude/sonnet" style={{ display: "inline" }}>
								Claude 3.7 Sonnet 的
							</VSCodeLink>
							智能编码能力，我可以逐步处理复杂的软件开发任务。借助可以创建和编辑文件、探索复杂项目、使用浏览器和执行终端命令的工具（在您授权后），我可以以超越代码补全或技术支持的方式为您提供帮助。我甚至可以使用
							MCP 创建新工具并扩展我自己的能力。
						</p>
					</div>
					{taskHistory.length > 0 && <HistoryPreview showHistoryView={showHistoryView} />}
				</div>
			)}

			{/* 
			// Flex 布局说明：
			// 1. 上面的内容 div 使用 flex: "1 1 0" 来：
			//    - 增长以填充可用空间 (flex-grow: 1) 
			//    - 在 AutoApproveMenu 需要空间时缩小 (flex-shrink: 1)
			//    - 从零大小开始 (flex-basis: 0) 以确保适当分配
			//    minHeight: 0 允许其缩小到内容高度以下
			//
			// 2. AutoApproveMenu 使用 flex: "0 1 auto" 来：
			//    - 不超过其内容增长 (flex-grow: 0)
			//    - 在视口较小时缩小 (flex-shrink: 1) 
			//    - 使用其内容大小作为基础 (flex-basis: auto)
			//    这确保在有空间时其自然高度
			//    但在视口过小时变得可滚动
			*/}
			{!task && (
				<AutoApproveMenu
					style={{
						marginBottom: -2,
						flex: "0 1 auto", // flex-grow: 0, flex-shrink: 1, flex-basis: auto
						minHeight: 0,
					}}
				/>
			)}

			{task && (
				<>
					<div style={{ flexGrow: 1, display: "flex" }} ref={scrollContainerRef}>
						<Virtuoso
							ref={virtuosoRef}
							key={task.ts} // 确保 virtuoso 在任务更改时重新渲染的技巧，并使用 initialTopMostItemIndex 从底部开始
							className="scrollable"
							style={{
								flexGrow: 1,
								overflowY: "scroll", // 始终显示滚动条
							}}
							components={{
								Footer: () => <div style={{ height: 5 }} />, // 在底部添加空填充
							}}
							// 增加顶部 3_000 以防止用户折叠行时跳动
							increaseViewportBy={{
								top: 3_000,
								bottom: Number.MAX_SAFE_INTEGER,
							}} // 黑客确保最后一条消息始终被渲染，以获得真正完美的滚动到底部动画，当新消息被添加时 (Number.MAX_SAFE_INTEGER 对于算术操作是安全的，virtuso 在 src/sizeRangeSystem.ts 中使用此值进行所有操作)
							data={groupedMessages} // 消息是扩展返回的原始格式，modifiedMessages 是组合某些相关类型消息的操作结构，visibleMessages 是过滤掉不应渲染的消息的结构
							itemContent={itemContent}
							atBottomStateChange={(isAtBottom) => {
								setIsAtBottom(isAtBottom)
								if (isAtBottom) {
									disableAutoScrollRef.current = false
								}
								setShowScrollToBottom(disableAutoScrollRef.current && !isAtBottom)
							}}
							atBottomThreshold={10} // 任何较低的值都会导致 followOutput 出现问题
							initialTopMostItemIndex={groupedMessages.length - 1}
						/>
					</div>
					<AutoApproveMenu />
					{showScrollToBottom ? (
						<div
							style={{
								display: "flex",
								padding: "10px 15px 0px 15px",
							}}>
							<ScrollToBottomButton
								onClick={() => {
									scrollToBottomSmooth()
									disableAutoScrollRef.current = false
								}}>
								<span className="codicon codicon-chevron-down" style={{ fontSize: "18px" }}></span>
							</ScrollToBottomButton>
						</div>
					) : (
						<div
							style={{
								opacity:
									primaryButtonText || secondaryButtonText || isStreaming
										? enableButtons || (isStreaming && !didClickCancel)
											? 1
											: 0.5
										: 0,
								display: "flex",
								padding: `${primaryButtonText || secondaryButtonText || isStreaming ? "10" : "0"}px 15px 0px 15px`,
							}}>
							{primaryButtonText && !isStreaming && (
								<VSCodeButton
									appearance="primary"
									disabled={!enableButtons}
									style={{
										flex: secondaryButtonText ? 1 : 2,
										marginRight: secondaryButtonText ? "6px" : "0",
									}}
									onClick={() => handlePrimaryButtonClick(inputValue, selectedImages)}>
									{primaryButtonText}
								</VSCodeButton>
							)}
							{(secondaryButtonText || isStreaming) && (
								<VSCodeButton
									appearance="secondary"
									disabled={!enableButtons && !(isStreaming && !didClickCancel)}
									style={{
										flex: isStreaming ? 2 : 1,
										marginLeft: isStreaming ? 0 : "6px",
									}}
									onClick={() => handleSecondaryButtonClick(inputValue, selectedImages)}>
									{isStreaming ? "取消" : secondaryButtonText}
								</VSCodeButton>
							)}
						</div>
					)}
				</>
			)}
			<ChatTextArea
				ref={textAreaRef}
				inputValue={inputValue}
				setInputValue={setInputValue}
				textAreaDisabled={textAreaDisabled}
				placeholderText={placeholderText}
				selectedImages={selectedImages}
				setSelectedImages={setSelectedImages}
				onSend={() => handleSendMessage(inputValue, selectedImages)}
				onSelectImages={selectImages}
				shouldDisableImages={shouldDisableImages}
				onHeightChange={() => {
					if (isAtBottom) {
						scrollToBottomAuto()
					}
				}}
			/>
		</div>
	)
}

const ScrollToBottomButton = styled.div`
	background-color: color-mix(in srgb, var(--vscode-toolbar-hoverBackground) 55%, transparent);
	border-radius: 3px;
	overflow: hidden;
	cursor: pointer;
	display: flex;
	justify-content: center;
	align-items: center;
	flex: 1;
	height: 25px;

	&:hover {
		background-color: color-mix(in srgb, var(--vscode-toolbar-hoverBackground) 90%, transparent);
	}

	&:active {
		background-color: color-mix(in srgb, var(--vscode-toolbar-hoverBackground) 70%, transparent);
	}
`

export default ChatView
