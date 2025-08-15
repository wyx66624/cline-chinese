import { Anthropic } from "@anthropic-ai/sdk"
import * as diff from "diff"
import * as path from "path"
import { ClineIgnoreController, LOCK_TEXT_SYMBOL } from "../ignore/ClineIgnoreController"
import { Mode } from "@/shared/storage/types"

export const formatResponse = {
	duplicateFileReadNotice: () =>
		`[[注意] 此文件读取已被移除以节省上下文窗口中的空间。请参考最新的文件读取以获取此文件的最新版本。]`,

	contextTruncationNotice: () =>
		`[注意] 一些之前的用户对话历史已被移除以保持最佳上下文窗口长度。初始用户任务和最近的交流已被保留以保持连续性，而中间的对话历史已被移除。请在继续协助用户时记住这一点。`,

	condense: () =>
		`用户已接受您生成的压缩对话摘要。此摘要涵盖了已被截断的用户历史对话的重要细节。\n<explicit_instructions type="condense_response">关键的是，您必须通过仅询问用户您应该接下来做什么来回应。您不应该采取任何主动性或对继续工作做任何假设。例如，您不应该建议文件更改或尝试读取任何文件。\n当询问用户您应该接下来做什么时，您可以引用刚刚生成的摘要中的信息。但是，您不应该引用此响应摘要之外的信息。保持此响应简洁。</explicit_instructions>`,

	toolDenied: () => `用户拒绝了此操作。`,

	toolError: (error?: string) => `工具执行失败，出现以下错误：\n<error>\n${error}\n</error>`,

	clineIgnoreError: (path: string) =>
		`对 ${path} 的访问被 .clineignore 文件设置阻止。您必须尝试在不使用此文件的情况下继续任务，或要求用户更新 .clineignore 文件。`,

	noToolsUsed: () =>
		`[错误] 您在之前的响应中没有使用工具！请重试并使用工具。

${toolUseInstructionsReminder}

# 下一步

如果您已完成用户的任务，请使用 attempt_completion 工具。
如果您需要从用户那里获得额外信息，请使用 ask_followup_question 工具。
否则，如果您没有完成任务且不需要额外信息，请继续执行任务的下一步。
（这是一条自动化消息，所以请不要以对话方式回应它。）`,

	tooManyMistakes: (feedback?: string) =>
		`您似乎在继续前进时遇到困难。用户提供了以下反馈来帮助指导您：\n<feedback>\n${feedback}\n</feedback>`,

	autoApprovalMaxReached: (feedback?: string) =>
		`已达到自动批准限制。用户提供了以下反馈来帮助指导您：\n<feedback>\n${feedback}\n</feedback>`,

	missingToolParameterError: (paramName: string) =>
		`缺少必需参数 '${paramName}' 的值。请重试并提供完整响应。\n\n${toolUseInstructionsReminder}`,

	invalidMcpToolArgumentError: (serverName: string, toolName: string) =>
		`与 ${serverName} 一起使用的 ${toolName} 的 JSON 参数无效。请重试并提供格式正确的 JSON 参数。`,

	toolResult: (
		text: string,
		images?: string[],
		fileString?: string,
	): string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> => {
		let toolResultOutput = []

		if (!(images && images.length > 0) && !fileString) {
			return text
		}

		const textBlock: Anthropic.TextBlockParam = { type: "text", text }
		toolResultOutput.push(textBlock)

		if (images && images.length > 0) {
			const imageBlocks: Anthropic.ImageBlockParam[] = formatImagesIntoBlocks(images)
			toolResultOutput.push(...imageBlocks)
		}

		if (fileString) {
			const fileBlock: Anthropic.TextBlockParam = { type: "text", text: fileString }
			toolResultOutput.push(fileBlock)
		}

		return toolResultOutput
	},

	imageBlocks: (images?: string[]): Anthropic.ImageBlockParam[] => {
		return formatImagesIntoBlocks(images)
	},

	formatFilesList: (
		absolutePath: string,
		files: string[],
		didHitLimit: boolean,
		clineIgnoreController?: ClineIgnoreController,
	): string => {
		const sorted = files
			.map((file) => {
				// 将绝对路径转换为相对路径
				const relativePath = path.relative(absolutePath, file).toPosix()
				return file.endsWith("/") ? relativePath + "/" : relativePath
			})
			// 排序，使文件列在各自的目录下，清楚显示哪些文件是哪些目录的子项。由于我们从上到下构建文件列表，即使文件列表被截断，它也会显示 Cline 可以进一步探索的目录。
			.sort((a, b) => {
				const aParts = a.split("/") // 只有在我们先使用 toPosix 时才有效
				const bParts = b.split("/")
				for (let i = 0; i < Math.min(aParts.length, bParts.length); i++) {
					if (aParts[i] !== bParts[i]) {
						// 如果一个是目录而另一个在这个级别不是，则目录排在前面
						if (i + 1 === aParts.length && i + 1 < bParts.length) {
							return -1
						}
						if (i + 1 === bParts.length && i + 1 < aParts.length) {
							return 1
						}
						// 否则，按字母顺序排序
						return aParts[i].localeCompare(bParts[i], undefined, {
							numeric: true,
							sensitivity: "base",
						})
					}
				}
				// 如果所有部分都相同，直到较短路径的长度，
				// 较短的排在前面
				return aParts.length - bParts.length
			})

		const clineIgnoreParsed = clineIgnoreController
			? sorted.map((filePath) => {
					// 路径相对于绝对路径，而不是 cwd
					// validateAccess 期望相对于 cwd 的路径或绝对路径
					// 否则，对于验证忽略模式如 "assets/icons"，我们最终只会得到 "icons"，这会导致路径不被忽略。
					const absoluteFilePath = path.resolve(absolutePath, filePath)
					const isIgnored = !clineIgnoreController.validateAccess(absoluteFilePath)
					if (isIgnored) {
						return LOCK_TEXT_SYMBOL + " " + filePath
					}

					return filePath
				})
			: sorted

		if (didHitLimit) {
			return `${clineIgnoreParsed.join(
				"\n",
			)}\n\n(文件列表已截断。如果您需要进一步探索，请在特定子目录上使用 list_files。)`
		} else if (clineIgnoreParsed.length === 0 || (clineIgnoreParsed.length === 1 && clineIgnoreParsed[0] === "")) {
			return "未找到文件。"
		} else {
			return clineIgnoreParsed.join("\n")
		}
	},

	createPrettyPatch: (filename = "file", oldStr?: string, newStr?: string) => {
		// 字符串不能是 undefined，否则 diff 会抛出异常
		const patch = diff.createPatch(filename.toPosix(), oldStr || "", newStr || "")
		const lines = patch.split("\n")
		const prettyPatchLines = lines.slice(4)
		return prettyPatchLines.join("\n")
	},

	taskResumption: (
		mode: Mode,
		agoText: string,
		cwd: string,
		wasRecent: boolean | 0 | undefined,
		responseText?: string,
		hasPendingFileContextWarnings?: boolean,
	): [string, string] => {
		const taskResumptionMessage = `[任务恢复] ${
			mode === "plan"
				? `此任务在 ${agoText} 被中断。对话可能不完整。请注意，项目状态可能从那时起已经改变。当前工作目录现在是 '${cwd.toPosix()}'。\n\n注意：如果您之前尝试使用工具但用户没有提供结果，您应该假设工具使用不成功。但是您处于计划模式，所以不要继续任务，您必须回应用户的消息。`
				: `此任务在 ${agoText} 被中断。它可能完成也可能未完成，所以请重新评估任务上下文。请注意，项目状态可能从那时起已经改变。当前工作目录现在是 '${cwd.toPosix()}'。如果任务未完成，请重试中断前的最后一步并继续完成任务。\n\n注意：如果您之前尝试使用工具但用户没有提供结果，您应该假设工具使用不成功并评估是否应该重试。如果最后一个工具是 browser_action，浏览器已关闭，如果需要，您必须启动新的浏览器。`
		}${
			wasRecent && !hasPendingFileContextWarnings
				? "\n\n重要：如果最后一个工具使用是被中断的 replace_in_file 或 write_to_file，文件在中断编辑前已恢复到其原始状态，您不需要重新读取文件，因为您已经有了它的最新内容。"
				: ""
		}`

		const userResponseMessage = `${
			responseText
				? `${mode === "plan" ? "使用 plan_mode_respond 工具回应的新消息（确保在 <response> 参数中提供您的响应）" : "任务继续的新指令"}:\n<user_message>\n${responseText}\n</user_message>`
				: mode === "plan"
					? "(用户没有提供新消息。考虑询问他们希望您如何继续，或建议他们切换到执行模式以继续任务。)"
					: ""
		}`

		return [taskResumptionMessage, userResponseMessage]
	},

	planModeInstructions: () => {
		return `在此模式下，您应该专注于信息收集、提问和架构解决方案。一旦您有了计划，请使用 plan_mode_respond 工具与用户进行对话交流。在您收集到所需的所有信息（例如通过 read_file 或 ask_followup_question）之前，不要使用 plan_mode_respond 工具。
(记住：如果用户似乎希望您使用仅在执行模式中可用的工具，您应该要求用户"切换到执行模式"（使用这些词）- 他们必须手动使用下面的计划/执行切换按钮自己执行此操作。您没有能力自己切换到执行模式，必须等待用户在他们对计划满意后自己执行。您也不能提供切换到执行模式的选项，因为这是您需要指导用户手动自己执行的操作。)"
	},

	fileEditWithUserChanges: (
		relPath: string,
		userEdits: string,
		autoFormattingEdits: string | undefined,
		finalContent: string | undefined,
		newProblemsMessage: string | undefined,
	) =>
		`用户对您的内容进行了以下更新：\n\n${userEdits}\n\n` +
		(autoFormattingEdits
			? `用户的编辑器还对您的内容应用了以下自动格式化：\n\n${autoFormattingEdits}\n\n(注意：密切关注单引号转换为双引号、分号被移除或添加、长行被分解为多行、调整缩进样式、添加/移除尾随逗号等更改。这将帮助您确保对此文件的未来搜索/替换操作是准确的。)\n\n`
			: "") +
		`更新的内容，包括您的原始修改和额外编辑，已成功保存到 ${relPath.toPosix()}。以下是保存的文件完整更新内容：\n\n` +
		`<final_file_content path="${relPath.toPosix()}">\n${finalContent}\n</final_file_content>\n\n` +
		`请注意：\n` +
		`1. 您不需要使用这些更改重写文件，因为它们已经被应用。\n` +
		`2. 使用此更新文件内容作为新基线继续任务。\n` +
		`3. 如果用户的编辑解决了部分任务或改变了要求，请相应地调整您的方法。` +
		`4. 重要：对于此文件的任何未来更改，请使用上面显示的 final_file_content 作为您的参考。此内容反映了文件的当前状态，包括用户编辑和任何自动格式化（例如，如果您使用单引号但格式化器将它们转换为双引号）。始终基于此最终版本进行搜索/替换操作以确保准确性。\n` +
		`${newProblemsMessage}`,

	fileEditWithoutUserChanges: (
		relPath: string,
		autoFormattingEdits: string | undefined,
		finalContent: string | undefined,
		newProblemsMessage: string | undefined,
	) =>
		`内容已成功保存到 ${relPath.toPosix()}。\n\n` +
		(autoFormattingEdits
			? `除了您的编辑外，用户的编辑器还对您的内容应用了以下自动格式化：\n\n${autoFormattingEdits}\n\n(注意：密切关注单引号转换为双引号、分号被移除或添加、长行被分解为多行、调整缩进样式、添加/移除尾随逗号等更改。这将帮助您确保对此文件的未来搜索/替换操作是准确的。)\n\n`
			: "") +
		`以下是保存的文件完整更新内容：\n\n` +
		`<final_file_content path="${relPath.toPosix()}">\n${finalContent}\n</final_file_content>\n\n` +
		`重要：对于此文件的任何未来更改，请使用上面显示的 final_file_content 作为您的参考。此内容反映了文件的当前状态，包括任何自动格式化（例如，如果您使用单引号但格式化器将它们转换为双引号）。始终基于此最终版本进行搜索/替换操作以确保准确性。\n\n` +
		`${newProblemsMessage}`,

	diffError: (relPath: string, originalContent: string | undefined) =>
		`这可能是因为搜索块内容与文件中的内容不完全匹配，或者如果您使用了多个搜索/替换块，它们可能没有按照它们在文件中出现的顺序排列。（还请确保在使用 replace_in_file 工具时，不要在标记中添加额外字符（例如，------- SEARCH> 是无效的）。不要忘记使用结束的 +++++++ REPLACE 标记。不要以任何方式修改标记格式。格式错误的 XML 将导致工具完全失败并破坏整个编辑过程。）\n\n` +
		`文件已恢复到其原始状态：\n\n` +
		`<file_content path="${relPath.toPosix()}">\n${originalContent}\n</file_content>\n\n` +
		`现在您有了文件的最新状态，请使用更少、更精确的搜索块重试操作。特别是对于大文件，谨慎地尝试限制自己一次使用 <5 个搜索/替换块，然后等待用户响应操作结果，然后再进行另一个 replace_in_file 调用来进行额外编辑。\n(如果您连续遇到此错误 3 次，您可以使用 write_to_file 工具作为备用方案。)`,

	toolAlreadyUsed: (toolName: string) =>
		`工具 [${toolName}] 未执行，因为在此消息中已经使用了工具。每条消息只能使用一个工具。您必须在继续使用下一个工具之前评估第一个工具的结果。`,

	clineIgnoreInstructions: (content: string) =>
		`# .clineignore\n\n(以下由根级 .clineignore 文件提供，用户在其中指定了不应访问的文件和目录。使用 list_files 时，您会注意到被阻止的文件旁边有一个 ${LOCK_TEXT_SYMBOL}。尝试访问文件内容（例如通过 read_file）将导致错误。)\n\n${content}\n.clineignore`,

	clineRulesGlobalDirectoryInstructions: (globalClineRulesFilePath: string, content: string) =>
		`# .clinerules/\n\n以下由全局 .clinerules/ 目录提供，位于 ${globalClineRulesFilePath.toPosix()}，用户在其中为所有工作目录指定了指令：\n\n${content}`,

	clineRulesLocalDirectoryInstructions: (cwd: string, content: string) =>
		`# .clinerules/\n\n以下由根级 .clinerules/ 目录提供，用户在其中为此工作目录 (${cwd.toPosix()}) 指定了指令\n\n${content}`,

	clineRulesLocalFileInstructions: (cwd: string, content: string) =>
		`# .clinerules\n\n以下由根级 .clinerules 文件提供，用户在其中为此工作目录 (${cwd.toPosix()}) 指定了指令\n\n${content}`,

	windsurfRulesLocalFileInstructions: (cwd: string, content: string) =>
		`# .windsurfrules\n\n以下由根级 .windsurfrules 文件提供，用户在其中为此工作目录 (${cwd.toPosix()}) 指定了指令\n\n${content}`,

	cursorRulesLocalFileInstructions: (cwd: string, content: string) =>
		`# .cursorrules\n\n以下由根级 .cursorrules 文件提供，用户在其中为此工作目录 (${cwd.toPosix()}) 指定了指令\n\n${content}`,

	cursorRulesLocalDirectoryInstructions: (cwd: string, content: string) =>
		`# .cursor/rules\n\n以下由根级 .cursor/rules 目录提供，用户在其中为此工作目录 (${cwd.toPosix()}) 指定了指令\n\n${content}`,

	fileContextWarning: (editedFiles: string[]): string => {
		const fileCount = editedFiles.length
		const fileVerb = fileCount === 1 ? "文件已" : "文件已"
		const fileDemonstrativePronoun = fileCount === 1 ? "此文件" : "这些文件"
		const filePersonalPronoun = fileCount === 1 ? "它" : "它们"

		return (
			`<explicit_instructions>\n关键文件状态警报：${fileCount} 个 ${fileVerb} 在您上次交互后被外部修改。您对 ${fileDemonstrativePronoun} 的缓存理解现在已过时且不可靠。在对 ${fileDemonstrativePronoun} 进行任何修改之前，您必须执行 read_file 以获取当前状态，因为 ${filePersonalPronoun} 可能包含与您期望完全不同的内容：\n` +
			`${editedFiles.map((file) => ` ${path.resolve(file).toPosix()}`).join("\n")}\n` +
			`在编辑前不重新读取将导致 replace_in_file 编辑错误，需要后续尝试并浪费令牌。在后续编辑后，您不需要重新读取这些文件，除非被指示这样做。\n</explicit_instructions>`
		)
	},
}

// 避免循环依赖
const formatImagesIntoBlocks = (images?: string[]): Anthropic.ImageBlockParam[] => {
	return images
		? images.map((dataUrl) => {
				// data:image/png;base64,base64string
				const [rest, base64] = dataUrl.split(",")
				const mimeType = rest.split(":")[1].split(";")[0]
				return {
					type: "image",
					source: {
						type: "base64",
						media_type: mimeType,
						data: base64,
					},
				} as Anthropic.ImageBlockParam
			})
		: []
}

const toolUseInstructionsReminder = `# 提醒：工具使用说明

工具使用使用 XML 样式的标签进行格式化。工具名称包含在开始和结束标签中，每个参数也类似地包含在其自己的标签集中。以下是结构：

<tool_name>
<parameter1_name>value1</parameter1_name>
<parameter2_name>value2</parameter2_name>
...
</tool_name>

例如：

<attempt_completion>
<result>
我已经完成任务...
</result>
</attempt_completion>

始终遵循此格式进行所有工具使用，以确保正确的解析和执行。`
