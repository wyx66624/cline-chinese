import { useDebouncedInput } from "../utils/useDebouncedInput"
import { VSCodeTextField, VSCodeLink } from "@vscode/webview-ui-toolkit/react"

/**
 * Props for the ApiKeyField component
 */
interface ApiKeyFieldProps {
	initialValue: string
	onChange: (value: string) => void
	providerName: string
	signupUrl?: string
	placeholder?: string
	helpText?: string
}

/**
 * A reusable component for API key input fields with standard styling and help text for signing up for key
 */
export const ApiKeyField = ({
	initialValue,
	onChange,
	providerName,
	signupUrl,
	placeholder = "输入 API 密钥...",
	helpText,
}: ApiKeyFieldProps) => {
	const [localValue, setLocalValue] = useDebouncedInput(initialValue, onChange)

	return (
		<div>
			<VSCodeTextField
				value={localValue}
				style={{ width: "100%" }}
				type="password"
				onInput={(e: any) => setLocalValue(e.target.value)}
				required={true}
				placeholder={placeholder}>
				<span style={{ fontWeight: 500 }}>{providerName} API Key</span>
			</VSCodeTextField>
			<p
				style={{
					fontSize: "12px",
					marginTop: 3,
					color: "var(--vscode-descriptionForeground)",
				}}>
				{helpText || "此密钥已本地存储，仅用于从本扩展程序发出 API 请求。"}
				{!localValue && signupUrl && (
					<VSCodeLink
						href={signupUrl}
						style={{
							display: "inline",
							fontSize: "inherit",
						}}>
						您可以通过在此处注册来获取{/^[aeiou]/i.test(providerName) ? "n" : ""} {providerName} API 密钥。
					</VSCodeLink>
				)}
			</p>
		</div>
	)
}
