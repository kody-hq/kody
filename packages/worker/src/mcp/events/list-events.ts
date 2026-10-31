import { chunkArray } from '@kody-internal/shared/chunk.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	checkPermission,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { listPackageEmittedEvents } from '#worker/package-registry/manifest.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'

const manifestLoadConcurrency = 5

/** v1 events take no subscription arguments; `{}` is the only valid value. */
export const mcpEventInputSchema = {
	type: 'object',
	properties: {},
	additionalProperties: false,
} as const

const genericPayloadSchema = { type: 'object' } as const

export type McpEventDefinition = {
	name: string
	description: string
	delivery: Array<'webhook'>
	inputSchema: typeof mcpEventInputSchema
	payloadSchema: Record<string, unknown>
}

export type McpEventSource = {
	definition: McpEventDefinition
	/** Saved packages (caller-visible) that declare this topic with `mcp: true`. */
	packageIds: Array<string>
}

/**
 * MCP-exposed events for one caller: `kody.emits` topics declared with
 * `mcp: true` in the caller's saved packages that the connection may read
 * (profile grants apply). Event name = package topic. Keyed and
 * sorted by name; the first package (by kodyId) owns a shared topic's
 * descriptor.
 */
export async function listMcpEventSources(input: {
	env: Env
	callerContext: McpCallerContext
}): Promise<Map<string, McpEventSource>> {
	const userId = input.callerContext.user?.userId
	const { request } = input.callerContext
	if (!userId || !request) {
		throw new Error('MCP events require an authenticated user.')
	}
	const ownerId = request.org.id
	const [access, savedPackages] = await Promise.all([
		computeEffectivePermissions({ env: input.env, request }),
		listSavedPackagesByUserId(input.env.APP_DB, { userId: ownerId }),
	])
	const readablePackages = savedPackages
		.filter(
			(savedPackage) =>
				checkPermission(access, 'package:read', packageResource(savedPackage))
					.allowed,
		)
		.sort((left, right) => left.kodyId.localeCompare(right.kodyId))

	const sources = new Map<string, McpEventSource>()
	for (const chunk of chunkArray(readablePackages, manifestLoadConcurrency)) {
		const settled = await Promise.allSettled(
			chunk.map((savedPackage) =>
				loadMcpEventsForPackage({
					env: input.env,
					baseUrl: input.callerContext.baseUrl,
					userId: ownerId,
					savedPackage,
				}),
			),
		)
		for (const [index, result] of settled.entries()) {
			const savedPackage = chunk[index]!
			if (result.status === 'rejected') {
				console.warn('mcp-events-manifest-load-failed', {
					packageId: savedPackage.id,
					sourceId: savedPackage.sourceId,
					error: result.reason,
				})
				continue
			}
			for (const definition of result.value) {
				const existing = sources.get(definition.name)
				if (existing) {
					existing.packageIds.push(savedPackage.id)
				} else {
					sources.set(definition.name, {
						definition,
						packageIds: [savedPackage.id],
					})
				}
			}
		}
	}
	return new Map(
		[...sources.entries()].sort(([left], [right]) => left.localeCompare(right)),
	)
}

async function loadMcpEventsForPackage(input: {
	env: Env
	baseUrl: string
	userId: string
	savedPackage: SavedPackageRecord
}): Promise<Array<McpEventDefinition>> {
	const loaded = await loadPackageManifestBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceId: input.savedPackage.sourceId,
	})
	return listPackageEmittedEvents(loaded.manifest)
		.filter((event) => event.mcp)
		.map((event) => ({
			name: event.topic,
			description: event.description,
			delivery: ['webhook'],
			inputSchema: mcpEventInputSchema,
			payloadSchema: event.payloadSchema ?? genericPayloadSchema,
		}))
}
