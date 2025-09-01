import * as vscode from "vscode"
import * as fs from "fs/promises"
import * as path from "path"
import { Browser, Page, launch } from "puppeteer-core"
import * as cheerio from "cheerio"
import TurndownService from "turndown"
// @ts-ignore
import PCR from "puppeteer-chromium-resolver"
import { fileExistsAtPath } from "@utils/fs"
import { BrowserSettings, DEFAULT_BROWSER_SETTINGS } from "@shared/BrowserSettings" // Import the interface and defaults

interface PCRStats {
	puppeteer: { launch: typeof launch } // 含有 launch 方法的 puppeteer 实例封装
	executablePath: string // Chromium 可执行文件绝对路径
}

/**
 * UrlContentFetcher
 * 作用：利用 puppeteer 打开网页，将主体 HTML 清理后转为 Markdown 供模型纳入上下文。
 * 负责：
 *  - 确保本地存在（或下载）Chromium
 *  - 启动浏览器 + 创建页面
 *  - 加载 URL、等待基本稳定 (domcontentloaded + networkidle2)
 *  - 过滤无关标签（script/style/nav/footer/header）
 *  - HTML -> Markdown (Turndown)
 * 使用方式：
 *  const f = new UrlContentFetcher(ctx); await f.launchBrowser(); const md = await f.urlToMarkdown(url); await f.closeBrowser();
 */

export class UrlContentFetcher {
	private context: vscode.ExtensionContext // VSCode 扩展上下文，用于存储目录
	private browser?: Browser // puppeteer Browser 实例
	private page?: Page // 当前单页面（简单场景只需要一个）

	constructor(context: vscode.ExtensionContext) {
		this.context = context
	}

	/** 确保已下载 Chromium（若不存在会自动下载）；返回执行路径与 puppeteer 封装 */
	private async ensureChromiumExists(): Promise<PCRStats> {
		const globalStoragePath = this.context?.globalStorageUri?.fsPath
		if (!globalStoragePath) {
			throw new Error("Global storage uri is invalid")
		}
		const puppeteerDir = path.join(globalStoragePath, "puppeteer")
		const dirExists = await fileExistsAtPath(puppeteerDir)
		if (!dirExists) {
			await fs.mkdir(puppeteerDir, { recursive: true })
		}
		// if chromium doesn't exist, this will download it to path.join(puppeteerDir, ".chromium-browser-snapshots")
		// if it does exist it will return the path to existing chromium
		const stats: PCRStats = await PCR({
			downloadPath: puppeteerDir,
		})
		return stats
	}

	/** 启动（如果尚未启动）浏览器并创建新页面 */
	async launchBrowser(): Promise<void> {
		if (this.browser) {
			return
		}
		const stats = await this.ensureChromiumExists()
		// Read browser settings from globalState for custom args only
		const browserSettings = this.context.globalState.get<BrowserSettings>("browserSettings", DEFAULT_BROWSER_SETTINGS)
		const customArgsStr = browserSettings.customArgs || ""
		const customArgs = customArgsStr.trim() ? customArgsStr.split(/\s+/) : []
		this.browser = await stats.puppeteer.launch({
			args: [
				"--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
				...customArgs, // Append user-provided custom arguments
			],
			executablePath: stats.executablePath,
		})
		// (latest version of puppeteer does not add headless to user agent)
		this.page = await this.browser?.newPage()
	}

	/** 关闭浏览器并释放引用 */
	async closeBrowser(): Promise<void> {
		await this.browser?.close()
		this.browser = undefined
		this.page = undefined
	}

	/**
	 * 加载指定 URL 并转为 Markdown。
	 * 需要：调用前确保已 launchBrowser。
	 */
	async urlToMarkdown(url: string): Promise<string> {
		if (!this.browser || !this.page) {
			throw new Error("Browser not initialized")
		}
		/*
		- networkidle2 is equivalent to playwright's networkidle where it waits until there are no more than 2 network connections for at least 500 ms.
		- domcontentloaded is when the basic DOM is loaded
		this should be sufficient for most doc sites
		*/
		await this.page.goto(url, {
			timeout: 10_000,
			waitUntil: ["domcontentloaded", "networkidle2"],
		})
		const content = await this.page.content()

		// use cheerio to parse and clean up the HTML
		const $ = cheerio.load(content)
		$("script, style, nav, footer, header").remove()

		// convert cleaned HTML to markdown
		const turndownService = new TurndownService()
		const markdown = turndownService.turndown($.html())

		return markdown
	}
}
