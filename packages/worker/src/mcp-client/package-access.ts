import type { McpServerRef } from '@kody-internal/shared/mcp-servers.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { orgSectionRestPath } from '#universal/org-section-hrefs.ts'
import { readSignupOrgSlug } from '#worker/orgs/signup-org-slug.ts'
import { getMcpServerSettingRowById } from './settings-repo.ts'
import type { McpServerSettingMetadata } from './settings-types.ts'
import {
	normalizeMcpServerUsageMode,
	type McpServerUsageMode,
} from './usage-mode.ts'

export type EnabledMcpServerRef = McpServerRef & {
	usageMode: McpServerUsageMode
	allowedPackageIds: ReadonlyArray<string>
}

export class McpServerPackageAccessDeniedError extends McpCallerError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = 'McpServerPackageAccessDeniedError'
	}
}

export function buildMcpServerUsageUrl(input: {
	baseUrl: string
	orgSlug: string
	serverId: string
}) {
	return new URL(
		orgSectionRestPath(input.orgSlug, 'mcp-servers', input.serverId),
		input.baseUrl,
	).toString()
}

export function createMcpServerExecuteAccessDeniedMessage(input: {
	serverName: string
	usageUrl: string
}) {
	return `MCP server "${input.serverName}" is limited to specific packages and cannot be used from execute. Approve a package at ${input.usageUrl}, or switch the server back to any context.`
}

export function createMcpServerPackageAccessDeniedMessage(input: {
	serverName: string
	packageName: string
	usageUrl: string
}) {
	return `Package "${input.packageName}" is not approved to use MCP server "${input.serverName}". Approve it at ${input.usageUrl}.`
}

export function canCallerUseMcpServer(input: {
	usageMode: McpServerUsageMode
	allowedPackageIds: ReadonlyArray<string>
	packageId?: string | null
}): boolean {
	if (input.usageMode === 'any') return true
	const packageId = input.packageId?.trim() ?? ''
	if (!packageId) return false
	return input.allowedPackageIds.includes(packageId)
}

export function filterEnabledMcpServerRefsForCaller(input: {
	refs: ReadonlyArray<EnabledMcpServerRef>
	packageId?: string | null
}): Array<McpServerRef> {
	return input.refs
		.filter((ref) =>
			canCallerUseMcpServer({
				usageMode: ref.usageMode,
				allowedPackageIds: ref.allowedPackageIds,
				packageId: input.packageId,
			}),
		)
		.map((ref) => ({
			serverId: ref.serverId,
			name: ref.name,
		}))
}

/**
 * `any` is execute plus every package. `packages` is only the listed ids —
 * execute (no packageId) is denied. Self-authored packages do not auto-pass.
 */
export async function assertCanUseMcpServer(input: {
	env: Pick<Env, 'APP_DB'>
	baseUrl: string
	userId: string
	serverId: string
	serverName: string
	packageId?: string | null
	packageKodyId?: string | null
	orgSlug?: string
}): Promise<void> {
	const row = await getMcpServerSettingRowById({
		db: input.env.APP_DB,
		userId: input.userId,
		id: input.serverId,
	})
	if (!row) return
	const usageMode = normalizeMcpServerUsageMode(row.usage_mode)
	if (usageMode === 'any') return
	const packageId = input.packageId?.trim() ?? ''
	if (packageId && row.allowedPackageIds.includes(packageId)) return
	const usageUrl = buildMcpServerUsageUrl({
		baseUrl: input.baseUrl,
		orgSlug:
			input.orgSlug?.trim() ||
			(await readSignupOrgSlug(input.env.APP_DB, input.userId)),
		serverId: row.id,
	})
	if (!packageId) {
		throw new McpServerPackageAccessDeniedError(
			createMcpServerExecuteAccessDeniedMessage({
				serverName: input.serverName,
				usageUrl,
			}),
		)
	}
	throw new McpServerPackageAccessDeniedError(
		createMcpServerPackageAccessDeniedMessage({
			serverName: input.serverName,
			packageName: input.packageKodyId?.trim() || packageId,
			usageUrl,
		}),
	)
}

export function mcpServerUsageFromMetadata(setting: McpServerSettingMetadata): {
	usageMode: McpServerUsageMode
	allowedPackageIds: Array<string>
} {
	return {
		usageMode: setting.usageMode,
		allowedPackageIds: [...setting.allowedPackageIds],
	}
}
