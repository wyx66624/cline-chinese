import * as net from "net"
import axios from "axios"

/**
 * 浏览器发现 / 连通性检测辅助函数集合。
 * 场景：被 BrowserSession 远程模式使用，用来探测本地或给定 host 上 9222 端口的 Chrome DevTools 协议是否可用。
 */

/**
 * 检测指定 host:port 是否可建立 TCP 连接。
 * @param host 主机名 (eg. localhost)
 * @param port 端口 (默认调试端口 9222 中会用到)
 * @param timeout 毫秒超时
 */
export async function isPortOpen(host: string, port: number, timeout = 1000): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = new net.Socket()
		let status = false

		// Set timeout
		socket.setTimeout(timeout)

		// Handle successful connection
		socket.on("connect", () => {
			status = true
			socket.destroy()
		})

		// Handle any errors
		socket.on("error", () => {
			socket.destroy()
		})

		// Handle timeout
		socket.on("timeout", () => {
			socket.destroy()
		})

		// Handle close
		socket.on("close", () => {
			resolve(status)
		})

		// Attempt to connect
		socket.connect(port, host)
	})
}

/**
 * 尝试访问 http://<ip>:9222/json/version 并解析 webSocketDebuggerUrl。
 * 成功返回 {endpoint, ip}，失败返回 null。
 */
export async function tryConnect(ipAddress: string): Promise<{ endpoint: string; ip: string } | null> {
	try {
		const response = await axios.get(`http://${ipAddress}:9222/json/version`, { timeout: 1000 })
		const data = response.data
		return { endpoint: data.webSocketDebuggerUrl, ip: ipAddress }
	} catch (error) {
		return null
	}
}

/**
 * 简单发现：仅在 localhost / 127.0.0.1 上尝试是否有开启 --remote-debugging-port=9222 的 Chrome。
 * 找到则返回基础 HTTP 前缀 (不含 /json/version)。
 */
export async function discoverChromeInstances(): Promise<string | null> {
	// Only try localhost
	const ipAddresses = ["localhost", "127.0.0.1"]

	// Try connecting to each IP address
	for (const ip of ipAddresses) {
		const connection = await tryConnect(ip)
		if (connection) {
			return `http://${connection.ip}:9222`
		}
	}

	return null
}

/**
 * 验证远程浏览器 DevTools 版本接口是否可访问，并返回实际的 webSocketDebuggerUrl。
 */
export async function testBrowserConnection(host: string): Promise<{ success: boolean; message: string; endpoint?: string }> {
	try {
		// Fetch the WebSocket endpoint from the Chrome DevTools Protocol
		const versionUrl = `${host.replace(/\/$/, "")}/json/version`

		const response = await axios.get(versionUrl, { timeout: 3000 })
		const browserWSEndpoint = response.data.webSocketDebuggerUrl

		if (!browserWSEndpoint) {
			return {
				success: false,
				message: "Could not find webSocketDebuggerUrl in the response",
			}
		}

		return {
			success: true,
			message: "Successfully connected to Chrome browser",
			endpoint: browserWSEndpoint,
		}
	} catch (error) {
		console.error(`Failed to connect to remote browser: ${error}`)
		return {
			success: false,
			message: `Failed to connect: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
}
