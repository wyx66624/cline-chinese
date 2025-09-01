import { globby, Options } from "globby"
import * as os from "os"
import * as path from "path"
import { arePathsEqual } from "@utils/path"

/**
 * 列出文件/目录的辅助工具：
 *  - 支持限制数量 (limit)
 *  - 支持递归（分层宽度优先遍历，避免一次性深度扫描造成阻塞）
 *  - 根据是否显式定位到隐藏目录，动态决定是否忽略所有点目录
 *  - 保护：禁止直接列出根目录与用户 home 目录，防止一次性返回过大结果
 */

// 常量：默认忽略的目录名称（以广泛生态中常见的构建/依赖/临时目录为主）
const DEFAULT_IGNORE_DIRECTORIES = [
	"node_modules",
	"__pycache__",
	"env",
	"venv",
	"target/dependency",
	"build/dependencies",
	"dist",
	"out",
	"bundle",
	"vendor",
	"tmp",
	"temp",
	"deps",
	"Pods",
]

// ================= 辅助函数 =================
/**
 * 判断路径是否为受限制的根路径（系统根或用户 home），这些路径不允许直接列出
 */
function isRestrictedPath(absolutePath: string): boolean {
	const root = process.platform === "win32" ? path.parse(absolutePath).root : "/"
	const isRoot = arePathsEqual(absolutePath, root)
	if (isRoot) {
		return true
	}

	const homeDir = os.homedir()
	const isHomeDir = arePathsEqual(absolutePath, homeDir)
	if (isHomeDir) {
		return true
	}

	return false
}

/**
 * 判断目标路径本身是否指向一个隐藏目录（目录名以 . 开头）
 */
function isTargetingHiddenDirectory(absolutePath: string): boolean {
	const dirName = path.basename(absolutePath)
	return dirName.startsWith(".")
}

/**
 * 构造 globby 忽略模式：
 *  - 若当前不是显式请求隐藏目录，则追加通配隐藏目录模式
 *  - 通配模式文字描述：两个星号 + 斜杠 + 目录名 + 斜杠 + 两个星号（例：匹配 node_modules 目录）
 *    为避免在注释里出现结束符号组合，不直接写出原始模式字面量。
 */
function buildIgnorePatterns(absolutePath: string): string[] {
	const isTargetHidden = isTargetingHiddenDirectory(absolutePath)

	const patterns = [...DEFAULT_IGNORE_DIRECTORIES]

	// 只有在未显式定位到隐藏目录时，才全局忽略所有隐藏目录
	if (!isTargetHidden) {
		patterns.push(".*")
	}

	return patterns.map((dir) => `**/${dir}/**`)
}

/**
 * 列出目标目录下文件/子目录
 * @param dirPath 目录路径（可相对，可绝对）
 * @param recursive 是否递归（宽度优先分层）
 * @param limit 返回的最大条目数（达到后即停止）
 * @returns [结果数组, 是否达到/超过限制]
 */
export async function listFiles(dirPath: string, recursive: boolean, limit: number): Promise<[string[], boolean]> {
	const absolutePath = path.resolve(dirPath)

	// 保护：禁止列出系统根与 home，避免产生超大结果或潜在隐私风险
	if (isRestrictedPath(absolutePath)) {
		return [[], false]
	}

	const options: Options = {
		cwd: dirPath,
		dot: true, // 不忽略隐藏文件/目录（后续再通过自定义忽略策略控制）
		absolute: true,
		markDirectories: true, // 让目录以 / 结尾，便于后续识别
		gitignore: recursive, // 递归模式下尊重 .gitignore
		ignore: recursive ? buildIgnorePatterns(absolutePath) : undefined,
		onlyFiles: false, // 结果中包含目录
		suppressErrors: true, // 避免权限或瞬态错误中断整体流程
	}

	const filePaths = recursive ? await globbyLevelByLevel(limit, options) : (await globby("*", options)).slice(0, limit)

	return [filePaths, filePaths.length >= limit]
}

/**
 * 宽度优先分层遍历（BFS）目录结构，直到达到 limit：
 *  - 使用队列逐层展开，保证不同深度的代表性
 *  - 在结果数量达到上限后立即停止
 *  - 利用 globby 标记目录（以 / 结尾）来继续向下层扩展
 *  - 若存在符号链接形成环路理论上可能重复，这里通过超时保护避免长时间阻塞
 * 备注：
 *  - 可以考虑 followSymlinks 相关策略；当前假设用户不会构造恶意循环
 *  - 提供 10 秒超时，超时返回已收集的部分结果
 */
async function globbyLevelByLevel(limit: number, options?: Options) {
	const results: Set<string> = new Set()
	const queue: string[] = ["*"]

	const globbingProcess = async () => {
		while (queue.length > 0 && results.size < limit) {
			const pattern = queue.shift()! //pattern:glob 模式字符串或模式数组
			//options:GlobbyOptions 对象
			const filesAtLevel = await globby(pattern, options)

			for (const file of filesAtLevel) {
				if (results.size >= limit) {
					break
				}
				results.add(file)
				if (file.endsWith("/")) {
					// Escape parentheses in the path to prevent glob pattern interpretation
					// This is crucial for NextJS folder naming conventions which use parentheses like (auth), (dashboard)
					// Without escaping, glob treats parentheses as special pattern grouping characters
					const escapedFile = file.replace(/\(/g, "\\(").replace(/\)/g, "\\)")
					queue.push(`${escapedFile}*`)
				}
			}
		}
		return Array.from(results).slice(0, limit)
	}

	// 10 秒超时：若遍历时间过长，返回已收集的部分结果
	const timeoutPromise = new Promise<string[]>((_, reject) => {
		setTimeout(() => reject(new Error("Globbing timeout")), 10_000)
	})
	try {
		return await Promise.race([globbingProcess(), timeoutPromise])
	} catch (error) {
		console.warn("Globbing timed out, returning partial results")
		return Array.from(results)
	}
}
