import * as path from "path"
import * as fs from "fs/promises"
import { createDirectoriesForFile } from "@utils/fs"
import { getCwd } from "@utils/path"
import { formatResponse } from "@core/prompts/responses"
import * as diff from "diff"
import { detectEncoding } from "../misc/extract-text"
import * as iconv from "iconv-lite"
import { HostProvider } from "@/hosts/host-provider"
import { DiagnosticSeverity, FileDiagnostics } from "@/shared/proto/index.cline"
import { diagnosticsToProblemsString, getNewDiagnostics } from "@/integrations/diagnostics"

/**
 * 差异视图提供者抽象类
 * 用于管理文件编辑的差异视图，支持文件创建和修改操作
 */
export abstract class DiffViewProvider {
	/** 编辑类型：创建文件或修改文件 */
	editType?: "create" | "modify"

	/** 是否正在编辑文件 */
	isEditing = false

	/** 文件的原始内容 */
	originalContent: string | undefined

	/** 为新文件创建的目录路径数组，用于在用户拒绝操作时删除 */
	private createdDirs: string[] = []

	/** 文档在编辑前是否已打开 */
	protected documentWasOpen = false

	/** 编辑前的诊断信息，用于比较编辑后的新问题 */
	private preDiagnostics: FileDiagnostics[] = []

	/** 相对路径 */
	protected relPath?: string

	/** 绝对路径 */
	protected absolutePath?: string

	/** 文件编码格式 */
	protected fileEncoding: string = "utf8"

	/** 已流式传输的行内容数组 */
	private streamedLines: string[] = []

	/** 新内容 */
	private newContent?: string

	constructor() {}

	/**
	 * 打开文件进行编辑
	 * @param relPath 相对路径
	 */
	public async open(relPath: string): Promise<void> {
		this.isEditing = true
		this.relPath = relPath
		this.absolutePath = path.resolve(await getCwd(), relPath)
		const fileExists = this.editType === "modify"

		// 如果文件已打开，确保在获取内容前不是脏数据
		if (fileExists) {
			await HostProvider.workspace.saveOpenDocumentIfDirty({
				filePath: this.absolutePath!,
			})

			const fileBuffer = await fs.readFile(this.absolutePath)
			this.fileEncoding = await detectEncoding(fileBuffer)
			this.originalContent = iconv.decode(fileBuffer, this.fileEncoding)
		} else {
			this.originalContent = ""
			this.fileEncoding = "utf8"
		}
		// 为新文件创建必要的目录，并跟踪新创建的目录以便在用户拒绝操作时删除
		this.createdDirs = await createDirectoriesForFile(this.absolutePath)
		// 确保文件在打开前存在
		if (!fileExists) {
			await fs.writeFile(this.absolutePath, "")
		}
		// 获取编辑前的诊断信息，编辑后将进行比较以查看是否需要修复
		this.preDiagnostics = (await HostProvider.workspace.getDiagnostics({})).fileDiagnostics
		await this.openDiffEditor()
		await this.scrollEditorToLine(0)
		this.streamedLines = []
	}

	/**
	 * 为当前文件打开差异编辑器或查看器
	 *
	 * 在确保文件存在并创建必要目录后，由 `open` 方法自动调用
	 *
	 * @returns 当差异编辑器打开并准备就绪时解析的Promise
	 */
	protected abstract openDiffEditor(): Promise<void>

	/**
	 * 滚动差异编辑器以显示特定行
	 *
	 * 在流式更新期间使用，以保持用户视图聚焦在变化的内容上
	 *
	 * @param line 要滚动到的从0开始的行号
	 */
	protected abstract scrollEditorToLine(line: number): Promise<void>

	/**
	 * 在差异编辑器中创建两行之间的平滑滚动动画
	 *
	 * 通常在更新包含多行时使用，以帮助用户直观地跟踪文档中的重要变化流
	 *
	 * @param startLine 开始动画的从0开始的行号
	 * @param endLine 动画结束的从0开始的行号
	 */
	protected abstract scrollAnimation(startLine: number, endLine: number): Promise<void>

	/**
	 * 从指定行到文档末尾删除内容
	 * 在接收到最终更新后调用
	 */
	protected abstract truncateDocument(lineNumber: number): Promise<void>

	/**
	 * 获取差异编辑器文档的内容
	 *
	 * 如果差异编辑器已关闭则返回undefined
	 */
	protected abstract getDocumentText(): Promise<string | undefined>

	/**
	 * 获取应用差异后出现的任何新诊断问题
	 *
	 * 在文件编辑前后获取诊断信息的方法比实时跟踪问题更好。
	 * 此方法确保我们只报告由此特定编辑直接导致的新问题。
	 * 由于这些是Cline编辑后出现的新问题，我们知道它们与他正在进行的工作直接相关。
	 * 这消除了Cline偏离任务或被不相关问题分散注意力的风险，这是之前自动调试方法的问题。
	 * 一些用户的机器可能更新诊断信息较慢，所以这种方法在自动化和避免潜在问题之间提供了良好的平衡，
	 * 避免Cline可能因为过时的问题信息而陷入循环。
	 * 如果用户接受更改时没有出现新问题，他们总是可以稍后使用'@problems'提及相关问题。
	 * 这样，Cline只会意识到由他的编辑导致的新问题，并相应地解决它们。
	 * 如果问题在应用修复后没有立即改变，Cline不会收到通知，这通常是可以接受的，
	 * 因为初始修复通常是正确的，可能只是需要时间让linter跟上。
	 */
	private async getNewDiagnosticProblems(): Promise<string> {
		// 获取更改文档后的诊断信息
		const postDiagnostics = (await HostProvider.workspace.getDiagnostics({})).fileDiagnostics

		const newProblems = getNewDiagnostics(this.preDiagnostics, postDiagnostics)
		// 只包含错误，因为警告可能会分散注意力（如果用户想要修复警告，他们可以使用@problems提及相关问题）
		// 如果没有错误则为空字符串
		const problems = await diagnosticsToProblemsString(newProblems, [DiagnosticSeverity.DIAGNOSTIC_ERROR])
		return problems
	}

	/**
	 * 将差异编辑器UI的内容保存到文件
	 *
	 * @returns 如果文件已保存则返回true
	 */
	protected abstract saveDocument(): Promise<Boolean>

	/**
	 * 关闭所有打开的差异视图
	 */
	protected abstract closeAllDiffViews(): Promise<void>

	/**
	 * 清理差异视图资源并重置内部状态
	 */
	protected abstract resetDiffView(): Promise<void>

	/**
	 * 更新差异视图内容
	 * @param accumulatedContent 累积的内容
	 * @param isFinal 是否为最终更新
	 * @param changeLocation 可选的更改位置信息
	 */
	async update(
		accumulatedContent: string,
		isFinal: boolean,
		changeLocation?: { startLine: number; endLine: number; startChar: number; endChar: number },
	) {
		if (!this.isEditing) {
			throw new Error("Not editing any file")
		}

		// --- 防止重复BOM的修复 ---
		// 从传入内容中剥离潜在的BOM。VS Code的`applyEdit`在从开始位置(0,0)替换时可能会隐式处理BOM，
		// 我们想要避免重复。最终的BOM在`saveChanges`中处理。
		if (accumulatedContent.startsWith("\ufeff")) {
			accumulatedContent = accumulatedContent.slice(1) // 移除BOM字符
		}

		this.newContent = accumulatedContent
		const accumulatedLines = accumulatedContent.split("\n")
		if (!isFinal) {
			accumulatedLines.pop() // 如果不是最终更新，移除最后一个部分行
		}
		const diffLines = accumulatedLines.slice(this.streamedLines.length)

		// 我们将按更大的块进行更新，而不是为每一行制作动画
		const currentLine = this.streamedLines.length + diffLines.length - 1
		if (currentLine >= 0) {
			// 只有当我们有新行时才继续

			// 将累积行替换到当前行的内容
			// 这是必要的（相比于一次插入一行），以处理HTML标签在前几行自动关闭等情况
			const contentToReplace = accumulatedLines.slice(0, currentLine + 1).join("\n") + "\n"
			const rangeToReplace = { startLine: 0, endLine: currentLine + 1 }
			await this.replaceText(contentToReplace, rangeToReplace, currentLine)

			// 如果提供了更改位置，则滚动到实际更改位置
			if (changeLocation) {
				// 我们有更改的实际位置，滚动到那里
				const targetLine = changeLocation.startLine
				await this.scrollEditorToLine(targetLine)
			} else {
				// 回退到旧逻辑处理非替换更新
				if (diffLines.length <= 5) {
					// 对于小的更改，直接跳转到该行
					await this.scrollEditorToLine(currentLine)
				} else {
					// 对于较大的更改，创建快速滚动动画
					const startLine = this.streamedLines.length
					const endLine = currentLine
					await this.scrollAnimation(startLine, endLine)
					// 确保我们结束在最终行
					await this.scrollEditorToLine(currentLine)
				}
			}
		}

		// 使用新的累积内容更新streamedLines
		this.streamedLines = accumulatedLines
		if (isFinal) {
			// 如果新内容比原始内容短，处理剩余的行
			await this.truncateDocument(this.streamedLines.length)

			// 如果原始内容有空的最后一行，则添加空行
			const hasEmptyLastLine = this.originalContent?.endsWith("\n")
			if (hasEmptyLastLine) {
				const accumulatedLines = accumulatedContent.split("\n")
				if (accumulatedLines[accumulatedLines.length - 1] !== "") {
					accumulatedContent += "\n"
				}
			}
		}
	}

	/**
	 * 用指定内容替换差异编辑器中的文本
	 *
	 * 这个抽象方法必须由子类实现，以处理其特定差异编辑器实现中的实际文本替换。
	 * 在流式更新过程中调用它以逐步显示更改。
	 *
	 * @param content 要插入到文档中的新内容
	 * @param rangeToReplace 指定要替换的行范围的对象
	 * @param currentLine 正在编辑的当前行号，用于滚动定位
	 * @returns 当文本替换完成时解析的Promise
	 */
	abstract replaceText(
		content: string,
		rangeToReplace: { startLine: number; endLine: number },
		currentLine: number | undefined,
	): Promise<void>

	/**
	 * 保存更改
	 * @returns 包含新问题消息、用户编辑、自动格式化编辑和最终内容的对象
	 */
	async saveChanges(): Promise<{
		newProblemsMessage: string | undefined
		userEdits: string | undefined
		autoFormattingEdits: string | undefined
		finalContent: string | undefined
	}> {
		// 获取保存操作前的内容，该操作可能会进行自动格式化
		const preSaveContent = await this.getDocumentText()

		if (!this.relPath || !this.absolutePath || !this.newContent || preSaveContent === undefined) {
			return {
				newProblemsMessage: undefined,
				userEdits: undefined,
				autoFormattingEdits: undefined,
				finalContent: undefined,
			}
		}

		await this.saveDocument()
		// 获取保存后的文本，以防编辑器进行了任何自动格式化
		const postSaveContent = (await this.getDocumentText()) || ""

		await HostProvider.window.showTextDocument({
			path: this.absolutePath,
			options: {
				preview: false,
				preserveFocus: true,
			},
		})
		await this.closeAllDiffViews()

		const newProblems = await this.getNewDiagnosticProblems()
		const newProblemsMessage =
			newProblems.length > 0 ? `\n\nNew problems detected after saving the file:\n${newProblems}` : ""

		// 如果编辑后的内容有不同的EOL字符，我们不想显示所有EOL差异的差异
		const newContentEOL = this.newContent.includes("\r\n") ? "\r\n" : "\n"
		const normalizedPreSaveContent = preSaveContent.replace(/\r\n|\n/g, newContentEOL).trimEnd() + newContentEOL // trimEnd修复编辑器自动添加额外新行的问题
		const normalizedPostSaveContent = postSaveContent.replace(/\r\n|\n/g, newContentEOL).trimEnd() + newContentEOL // 这是返回给模型的最终内容，用作未来编辑的新基线
		// 以防新内容混合了不同的EOL字符
		const normalizedNewContent = this.newContent.replace(/\r\n|\n/g, newContentEOL).trimEnd() + newContentEOL

		let userEdits: string | undefined
		if (normalizedPreSaveContent !== normalizedNewContent) {
			// 用户在批准编辑前进行了更改。让模型知道用户所做的更改（不包括保存后的自动格式化更改）
			userEdits = formatResponse.createPrettyPatch(this.relPath.toPosix(), normalizedNewContent, normalizedPreSaveContent)
			// return { newProblemsMessage, userEdits, finalContent: normalizedPostSaveContent }
		} else {
			// 没有对cline的编辑进行更改
			// return { newProblemsMessage, userEdits: undefined, finalContent: normalizedPostSaveContent }
		}

		let autoFormattingEdits: string | undefined
		if (normalizedPreSaveContent !== normalizedPostSaveContent) {
			// 编辑器进行了自动格式化
			autoFormattingEdits = formatResponse.createPrettyPatch(
				this.relPath.toPosix(),
				normalizedPreSaveContent,
				normalizedPostSaveContent,
			)
		}

		return {
			newProblemsMessage,
			userEdits,
			autoFormattingEdits,
			finalContent: normalizedPostSaveContent,
		}
	}

	/**
	 * 撤销更改
	 */
	async revertChanges(): Promise<void> {
		if (!this.absolutePath || !this.isEditing) {
			return
		}
		const fileExists = this.editType === "modify"

		if (!fileExists) {
			// 这是一个关键的保存语句-即使文件被保存然后立即删除。
			// 在vscode中，如果文件没有被保存，它将无法正确关闭差异编辑器。
			await this.saveDocument()
			await this.closeAllDiffViews()
			await fs.rm(this.absolutePath, { force: true })
			// 按相反顺序仅删除我们创建的目录
			for (let i = this.createdDirs.length - 1; i >= 0; i--) {
				await fs.rmdir(this.createdDirs[i])
				console.log(`Directory ${this.createdDirs[i]} has been deleted.`)
			}
			console.log(`File ${this.absolutePath} has been deleted.`)
		} else {
			// 恢复文档
			// 应用编辑并保存，由于内容不应该改变，这不会显示在本地历史中，
			// 除非用户在编辑期间进行了更改并保存。
			const contents = (await this.getDocumentText()) || ""
			const lineCount = (contents.match(/\n/g) || []).length + 1
			await this.replaceText(this.originalContent ?? "", { startLine: 0, endLine: lineCount }, undefined)

			await this.saveDocument()
			console.log(`File ${this.absolutePath} has been reverted to its original content.`)
			if (this.documentWasOpen) {
				await HostProvider.window.showTextDocument({
					path: this.absolutePath,
					options: {
						preview: false,
						preserveFocus: true,
					},
				})
			}
			await this.closeAllDiffViews()
		}

		// 编辑完成
		await this.reset()
	}

	/**
	 * 滚动到第一个差异
	 */
	async scrollToFirstDiff() {
		if (!this.isEditing) {
			return
		}
		const currentContent = (await this.getDocumentText()) || ""
		const diffs = diff.diffLines(this.originalContent || "", currentContent)
		let lineCount = 0
		for (const part of diffs) {
			if (part.added || part.removed) {
				// 找到第一个差异，滚动到那里
				this.scrollEditorToLine(lineCount)
				return
			}
			if (!part.removed) {
				lineCount += part.count || 0
			}
		}
	}

	/**
	 * 重置差异视图提供者
	 * 如果编辑器打开则关闭它？
	 */
	async reset() {
		this.isEditing = false
		this.editType = undefined
		this.absolutePath = undefined
		this.relPath = undefined
		this.preDiagnostics = []

		this.originalContent = undefined
		this.fileEncoding = "utf8"
		this.documentWasOpen = false

		this.streamedLines = []
		this.createdDirs = []
		this.newContent = undefined

		await this.resetDiffView()
	}
}
