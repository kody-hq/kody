import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type { McpCallerContext } from '@kody-internal/shared/chat.ts'
import { z } from 'zod'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'

export const packageRealtimeSessionRecordSchema = z.object({
	session_id: z.string(),
	facet: z.string(),
	topics: z.array(z.string()),
	connected_at: z.string(),
	last_seen_at: z.string(),
})

export const sessionEmitInputSchema = z.object({
	session_id: z.string().min(1),
	data: z.unknown(),
	package_id: z.string().min(1).optional(),
})

export const sessionEmitOutputSchema = z.object({
	delivered: z.boolean(),
	reason: z.string().optional(),
})

export const sessionBroadcastInputSchema = z.object({
	data: z.unknown(),
	topic: z.string().min(1).optional(),
	facet: z.string().min(1).optional(),
	package_id: z.string().min(1).optional(),
})

export const sessionBroadcastOutputSchema = z.object({
	delivered_count: z.number(),
	session_ids: z.array(z.string()),
})

export type PackageRealtimeContext = {
	user: ReturnType<typeof requireMcpUser>
	savedPackage: NonNullable<Awaited<ReturnType<typeof getSavedPackageById>>>
	realtime: Awaited<ReturnType<typeof createPackageRealtimeClient>>
}

function resolvePackageId(
	callerContext: McpCallerContext,
	explicitPackageId?: string | null,
) {
	const normalizedExplicit =
		typeof explicitPackageId === 'string' ? explicitPackageId.trim() : ''
	if (normalizedExplicit) {
		return normalizedExplicit
	}
	const appId = callerContext.storageContext?.appId?.trim() || ''
	if (appId) {
		return appId
	}
	// Agent calls from MCP omit package context unless they pass package_id.
	throw new McpCallerError(
		'Package realtime APIs require package_id, or a package app or package job caller context.',
	)
}

export async function requirePackageRealtimeContext(input: {
	env: Env
	callerContext: McpCallerContext
	explicitPackageId?: string | null
}): Promise<PackageRealtimeContext> {
	const user = requireMcpUser(input.callerContext)
	const packageId = resolvePackageId(
		input.callerContext,
		input.explicitPackageId,
	)
	// saved_packages.user_id and realtime DO names are org-keyed (ADR 0060/0063).
	const ownerOrgId =
		input.callerContext.request?.org.id ?? personalOrgIdForPerson(user)
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: ownerOrgId,
		packageId,
	})
	if (!savedPackage || !savedPackage.hasApp) {
		throw new McpCallerError(
			'Saved package app was not found for realtime operations.',
		)
	}
	return {
		user,
		savedPackage,
		realtime: await createPackageRealtimeClient({
			env: input.env,
			userId: ownerOrgId,
			packageId: savedPackage.id,
			kodyId: savedPackage.kodyId,
			sourceId: savedPackage.sourceId,
			baseUrl: input.callerContext.baseUrl,
		}),
	}
}

async function createPackageRealtimeClient(input: {
	env: Env
	userId: OwnerId
	packageId: string
	kodyId: string
	sourceId: string
	baseUrl: string
}) {
	const { packageRealtimeSessionRpc } =
		await import('#worker/package-runtime/realtime-session.ts')
	return packageRealtimeSessionRpc(input)
}
