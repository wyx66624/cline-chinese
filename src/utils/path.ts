import { HostProvider } from "@/hosts/host-provider"
import os from "os"
import * as path from "path"
import * as vscode from "vscode"

/*
Node.js 的 path 模块在不同平台上的解析与规范化策略不同：
1. Windows 默认使用反斜杠 (\\) 作为路径分隔符。
2. POSIX 系统 (Linux / macOS) 使用正斜杠 (/) 作为路径分隔符。

虽然可以使用诸如 upath 之类的库来统一为正斜杠，但这样在与某些依赖 Windows 原生路径形式的模块
（例如 vscode.fs、某些底层扩展 API）交互时，可能产生不一致或意外兼容性问题。

本文件采用的策略：
1. 面向 AI 及用户展示时，尽量用正斜杠（toPosixPath / String.prototype.toPosix）。
2. 进行路径比较时，使用 arePathsEqual 进行“逻辑等价”判断（大小写 / 尾部斜杠 / 分隔符差异）。
3. 实际与文件系统 / VS Code API 交互，仍使用 Node.js 原生 path 模块，保持平台正确性。

好处：保持显示一致性，同时不破坏跨平台底层行为。

注意：toPosixPath 和 arePathsEqual 主要用于“展示/比较”，不直接替代真实文件系统操作。

额外观察：
* Windows 下 Node.js 能自动兼容正/反斜杠混用；
* macOS / 类 Unix 系统下，反斜杠被视为普通字符，不会被自动转换。

本文件中出现的几类路径语义（用于后续函数注释中说明）：
* cwd: 当前工作区（第一个工作区文件夹）路径，或传入的默认值。
* workspacePath(s): VS Code 打开的一个或多个工作区根目录。
* absolutePath: 通过 path.resolve 计算出的绝对路径（可能源自 cwd + relPath）。
* relPath / normalizedRelPath: 相对 cwd 的相对路径形式。
* desktop dir: 用户桌面目录（用于无工作区时特殊显示策略）。
* extended-length path: Windows 特殊前缀 \\?\\ 开头的长路径形式。
*/

/**
 * 将路径中的反斜杠 (\\) 统一转换为正斜杠 (/)，用于展示与前端/AI 交互。
 * 特殊情况：Windows 扩展长度路径（以 \\?\\ 开头）保持原样，避免破坏其语义。
 * @param p 原始路径（可能是绝对 / 相对 / 扩展长度）
 * @returns 仅用于展示的 POSIX 风格路径（或原始扩展长度路径）
 */
function toPosixPath(p: string) {
	const isExtendedLengthPath = p.startsWith("\\\\?\\")
	if (isExtendedLengthPath) {
		return p
	}
	return p.replace(/\\/g, "/")
}

// 通过声明合并 (declaration merging) 给 String 原型添加 toPosix 方法。
// 注意：需要在入口文件（例如 extension.ts）显式 import 本文件才能确保运行期原型方法被挂载。
declare global {
	interface String {
		toPosix(): string
	}
}

String.prototype.toPosix = function (this: string): string {
	return toPosixPath(this)
}

/**
 * 跨平台安全比较两个路径是否“语义等价”。
 * 规则：
 * - 都为空 => true；一个为空 => false
 * - 先 normalizePath（统一分隔符 / 去尾斜杠 / 解析 .. .）
 * - Windows 下忽略大小写；其他平台区分大小写
 * @param path1 路径1
 * @param path2 路径2
 */
export function arePathsEqual(path1?: string, path2?: string): boolean {
	if (!path1 && !path2) {
		return true
	}
	if (!path1 || !path2) {
		return false
	}

	path1 = normalizePath(path1)
	path2 = normalizePath(path2)

	if (process.platform === "win32") {
		return path1.toLowerCase() === path2.toLowerCase()
	}
	return path1 === path2
}

/**
 * 规范化路径：
 * - 使用 path.normalize 解析 . / .. 与重复分隔符
 * - 移除非根路径尾部多余的 / 或 \\（保持比较一致性）
 * 不更改大小写（由 arePathsEqual 在 Windows 上处理）。
 * @param p 原始路径
 */
function normalizePath(p: string): string {
	let normalized = path.normalize(p)
	if (normalized.length > 1 && (normalized.endsWith("/") || normalized.endsWith("\\"))) {
		normalized = normalized.slice(0, -1)
	}
	return normalized
}

/**
 * 获取“可读”路径，用于 UI / AI 反馈：
 * 逻辑：
 * 1. 计算 absolutePath = resolve(cwd, relPath)
 * 2. 若 cwd 与桌面目录相等（用户未打开工作区，仅打开桌面）=> 显示完整绝对路径（避免用户误操作）
 * 3. 若 absolutePath 与 cwd 相同 => 显示最后一级目录名
 * 4. 否则，若 absolutePath 在 cwd 内部 => 显示相对路径
 * 5. 若不在内部（例如 ../../ 跳出）=> 显示绝对路径
 * @param cwd 当前工作区根（调用方一般传 getCwd() 结果）
 * @param relPath 相对路径（可能为空 / 绝对路径 / 含 ..）
 */
export function getReadablePath(cwd: string, relPath?: string): string {
	relPath = relPath || ""
	// path.resolve is flexible in that it will resolve relative paths like '../../' to the cwd and even ignore the cwd if the relPath is actually an absolute path
	const absolutePath = path.resolve(cwd, relPath)
	if (arePathsEqual(cwd, getDesktopDir())) {
		// User opened vscode without a workspace, so cwd is the Desktop. Show the full absolute path to keep the user aware of where files are being created
		return absolutePath.toPosix()
	}
	if (arePathsEqual(path.normalize(absolutePath), path.normalize(cwd))) {
		return path.basename(absolutePath).toPosix()
	} else {
		// show the relative path to the cwd
		const normalizedRelPath = path.relative(cwd, absolutePath)
		if (absolutePath.includes(cwd)) {
			return normalizedRelPath.toPosix()
		} else {
			// we are outside the cwd, so show the absolute path (useful for when cline passes in '../../' for example)
			return absolutePath.toPosix()
		}
	}
}

/**
 * 获取第一个工作区根目录路径；若无工作区则返回提供的 defaultCwd。
 * 依赖 HostProvider.workspace.getWorkspacePaths()（宿主桥接）。
 * @param defaultCwd 兜底值（无工作区场景）
 */
export async function getCwd(defaultCwd = ""): Promise<string> {
	const workspacePaths = await HostProvider.workspace.getWorkspacePaths({})
	return workspacePaths.paths.shift() || defaultCwd
}

/**
 * 获取当前用户桌面目录（用于“未打开工作区”时的特殊展示判定）。
 */
export function getDesktopDir() {
	return path.join(os.homedir(), "Desktop")
}

/**
 * 获取“当前活动编辑器中文件所属的工作区根路径”。
 * - 若无活动文件，则退回第一个工作区根（getCwd）。
 * - 若文件不属于任何已打开工作区（极少数情况），也回退 getCwd。
 */
export async function getWorkspacePath(defaultCwd = ""): Promise<string> {
	const currentFilePath = vscode.window.activeTextEditor?.document.uri.fsPath
	if (!currentFilePath) {
		return await getCwd(defaultCwd)
	}

	const workspacePaths = (await HostProvider.workspace.getWorkspacePaths({})).paths
	for (const workspacePath of workspacePaths) {
		if (isLocatedInPath(workspacePath, currentFilePath)) {
			return workspacePath
		}
	}
	return await getCwd(defaultCwd)
}

/**
 * 判断指定路径（可相对）是否位于任意已打开工作区之内。
 * 处理：对每个 workspacePath 进行 resolve 后用 isLocatedInPath 检测。
 * @param pathToCheck 待检测路径（可为空串 => 视为不匹配，最终返回 false）
 */
export async function isLocatedInWorkspace(pathToCheck: string = ""): Promise<boolean> {
	const workspacePaths = (await HostProvider.workspace.getWorkspacePaths({})).paths
	for (const workspacePath of workspacePaths) {
		const resolvedPath = path.resolve(workspacePath, pathToCheck)
		if (isLocatedInPath(workspacePath, resolvedPath)) {
			return true
		}
	}
	return false
}

/**
 * 判断 pathToCheck 是否位于 dirPath 目录内部。
 * 逻辑：
 * 1. 处理 Windows 长路径前缀（\\?\\）=> 直接用 startsWith 简化判断
 * 2. 计算 relative(dirPath, pathToCheck)
 * 3. 若 relative 以 .. 开头 => 不在内部
 * 4. 若 relative 是绝对路径 => 说明跨盘符（Windows）=> 不在内部
 * 5. 否则在内部
 */
export function isLocatedInPath(dirPath: string, pathToCheck: string): boolean {
	if (!dirPath || !pathToCheck) {
		return false
	}
	// Handle long paths in Windows
	if (dirPath.startsWith("\\\\?\\") || pathToCheck.startsWith("\\\\?\\")) {
		return pathToCheck.startsWith(dirPath)
	}

	const relativePath = path.relative(path.resolve(dirPath), path.resolve(pathToCheck))
	if (relativePath.startsWith("..")) {
		return false
	}
	if (path.isAbsolute(relativePath)) {
		// This can happen on windows when the two paths are on different drives.
		return false
	}
	return true
}

/**
 * 将给定文件绝对路径转换为相对于其所属工作区根的相对路径；
 * 若不在任何工作区内则原样返回。
 * @param filePath 目标文件绝对路径
 */
export async function asRelativePath(filePath: string): Promise<string> {
	const workspacePaths = await HostProvider.workspace.getWorkspacePaths({})
	for (const workspacePath of workspacePaths.paths) {
		if (isLocatedInPath(workspacePath, filePath)) {
			return path.relative(workspacePath, filePath)
		}
	}
	return filePath
}
