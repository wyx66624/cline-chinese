import vscode from "vscode"
import { openExternal } from "@/utils/env"
import { EmptyRequest, String } from "@shared/proto/cline/common"
import { Controller } from ".."

export async function shengSuanYunLoginClicked(controller: Controller, _: EmptyRequest): Promise<String> {
	const uriScheme = vscode.env.uriScheme
	const id = "cline-chinese"
	const author = "HybridTalentComputing"
	const authUrl = new URL(
		`https://router.shengsuanyun.com/auth?from=${id}&callback_url=${encodeURIComponent(`${uriScheme || "vscode"}://${author}.${id}/ssy`)}`,
	)
	const authUrlString = authUrl.toString()
	await openExternal(authUrlString)
	return String.create({ value: authUrlString })
}
