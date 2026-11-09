import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	buildCapabilityRegistry,
	type BuiltCapabilityRegistry,
} from './build-capability-registry.ts'
import {
	filterCapabilityRegistryForCaller,
	resolveCallerFeatureFlags,
	type CallerFeatureFlags,
} from './access-control.ts'
import { loadBuiltinDomains } from './builtin-domains.ts'
import { synthesizeMcpServerToolDomain } from './mcp-server/index.ts'
import type { McpCallerContext } from '@kody-internal/shared/chat.ts'
import type { McpServerRef } from '@kody-internal/shared/mcp-servers.ts'
import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'
import { getCachedMcpClientHubSnapshot } from '#worker/mcp-client/hub-client.ts'
import { listEnabledMcpServerRefsCached } from '#worker/mcp-client/settings-service.ts'
import type { McpServerSnapshot } from '#worker/mcp-client/types.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'

let staticRegistryMemo: Promise<BuiltCapabilityRegistry> | null = null

/**
 * Building the builtin registry loads every domain module (Zod schema
 * construction) and converts the capability schemas to JSON Schema, which is
 * far too expensive to run at module scope on every isolate cold start.
 * Memoized so the work happens at most once per isolate, on first use. Async
 * because the domain modules are loaded lazily (see `builtin-domains.ts`).
 */
export function getStaticRegistry(): Promise<BuiltCapabilityRegistry> {
	staticRegistryMemo ??= loadBuiltinDomains()
		.then((domains) => buildCapabilityRegistry(domains))
		.catch((error: unknown) => {
			staticRegistryMemo = null
			throw error
		})
	return staticRegistryMemo
}

export const capabilityRegistryCacheTtlMs = 30_000
export const capabilityRegistryCacheLimit = 50

function createCapabilityRegistryCache() {
	return new PromiseLruCache<BuiltCapabilityRegistry>({
		ttlMs: capabilityRegistryCacheTtlMs,
		limit: capabilityRegistryCacheLimit,
	})
}

const capabilityRegistryCache = createCapabilityRegistryCache()

function createCapabilityRegistryCacheKey(input: {
	userId: OwnerId
	mcpServerRefs: ReadonlyArray<McpServerRef>
	mcpServerSnapshots: ReadonlyArray<McpServerSnapshot | null>
}) {
	const mcpServerParts = input.mcpServerRefs
		.map((ref, index) => {
			const snapshot = input.mcpServerSnapshots[index] ?? null
			const refKey = `${ref.serverId}:${ref.name}`
			if (!snapshot || snapshot.state !== 'ready') {
				return `${refKey}:${snapshot?.state ?? 'disconnected'}`
			}
			const toolNames = snapshot.tools
				.map((tool) => tool.name)
				.sort()
				.join(',')
			return `${refKey}:ready:${toolNames}`
		})
		.sort()
	return `${input.userId}:mcp:${mcpServerParts.join('|')}`
}

async function buildCapabilityRegistryForDynamicSources(input: {
	mcpServerRefs: ReadonlyArray<McpServerRef>
	mcpServerSnapshots: ReadonlyArray<McpServerSnapshot | null>
}): Promise<BuiltCapabilityRegistry> {
	const synthesizedDomains = input.mcpServerRefs
		.map((ref, index) =>
			synthesizeMcpServerToolDomain({
				ref,
				snapshot: input.mcpServerSnapshots[index] ?? null,
			}),
		)
		.flatMap((domain) => (domain ? [domain.domain] : []))
	if (synthesizedDomains.length === 0) {
		return getStaticRegistry()
	}
	const builtinDomains = await loadBuiltinDomains()
	return buildCapabilityRegistry([...builtinDomains, ...synthesizedDomains])
}

function filterRegistryForContext(input: {
	registry: BuiltCapabilityRegistry
	callerContext: McpCallerContext
	featureFlags: CallerFeatureFlags | null
}) {
	return filterCapabilityRegistryForCaller(
		input.registry,
		input.callerContext,
		input.featureFlags,
	)
}

async function resolveFeatureFlagsForRegistry(input: {
	env: Env
	callerContext: McpCallerContext
	registry: BuiltCapabilityRegistry
}): Promise<CallerFeatureFlags | null> {
	// Skip the D1 reads when nothing in this registry is gated by a flag.
	// `callerCanAccessCapability` already fails closed on a missing map.
	if (
		!input.registry.capabilityList.some((capability) => capability.featureFlag)
	) {
		return null
	}
	return resolveCallerFeatureFlags(input.env, input.callerContext)
}

async function loadEnabledMcpServerRefs(input: {
	env: Pick<Env, 'APP_DB'>
	userId: OwnerId
}): Promise<ReadonlyArray<McpServerRef>> {
	try {
		// Per-owner 30s cache (bound org id): registry assembly runs on every
		// execute / package invocation, so this must not cost a D1 read per
		// call. Include package-locked servers so an approved package export
		// imported into execute can still dispatch kody.mcp["server"].tool —
		// assertCanUseMcpServer enforces the grant at call time via the
		// bundler stamp (secret-authority ALS), not via this listing filter.
		const refs = await listEnabledMcpServerRefsCached({
			env: input.env,
			userId: input.userId,
		})
		return refs.map((ref) => ({
			serverId: ref.serverId,
			name: ref.name,
		}))
	} catch {
		// A missing/unavailable settings table must not break builtin
		// capabilities; the caller just sees no MCP server domains.
		return []
	}
}

async function loadMcpServerSnapshots(input: {
	env: Env
	userId: OwnerId
	refs: ReadonlyArray<McpServerRef>
}): Promise<Array<McpServerSnapshot | null>> {
	if (input.refs.length === 0) return []
	try {
		const hubSnapshot = await getCachedMcpClientHubSnapshot({
			env: input.env,
			userId: input.userId,
		})
		return input.refs.map(
			(ref) =>
				hubSnapshot.servers.find(
					(server) => server.serverId === ref.serverId,
				) ?? null,
		)
	} catch {
		// A hub that cannot be reached must not break builtin capabilities.
		return input.refs.map(() => null)
	}
}

export async function getCapabilityRegistryForContext(input: {
	env: Env
	callerContext: McpCallerContext
}): Promise<BuiltCapabilityRegistry> {
	// MCP servers (and their hub connections) are org-owned. Use the bound
	// org — the same owner mcpServerList, kody.mcp metadata, and tool calls
	// already use — not the acting person's personal org. After an org
	// resource transfer, personal can be empty while the team still holds
	// ready servers; synthesizing from personal left kody.mcp showing
	// connected servers with no callable capabilities.
	const ownerId = ownerIdFromCaller(input.callerContext) || null
	// Flag evaluation does not depend on MCP server refs or hub snapshots.
	// Start it with the static registry so those reads overlap the flag D1
	// round trips. Dynamic registries reuse this result when the static
	// registry already has a gated capability (the common case).
	const staticRegistryPromise = getStaticRegistry()
	const flagsPromise = staticRegistryPromise.then((registry) =>
		resolveFeatureFlagsForRegistry({
			env: input.env,
			callerContext: input.callerContext,
			registry,
		}),
	)
	// MCP ref reads sit between this start and the await. Observe a rejection
	// now; awaiting `flagsPromise` later still throws.
	void flagsPromise.catch(() => {})
	if (!ownerId) {
		return filterRegistryForContext({
			registry: await staticRegistryPromise,
			callerContext: input.callerContext,
			featureFlags: await flagsPromise,
		})
	}
	const mcpServerRefs = await loadEnabledMcpServerRefs({
		env: input.env,
		userId: ownerId,
	})
	if (mcpServerRefs.length === 0) {
		return filterRegistryForContext({
			registry: await staticRegistryPromise,
			callerContext: input.callerContext,
			featureFlags: await flagsPromise,
		})
	}
	const mcpServerSnapshots = await loadMcpServerSnapshots({
		env: input.env,
		userId: ownerId,
		refs: mcpServerRefs,
	})
	const cacheKey = createCapabilityRegistryCacheKey({
		userId: ownerId,
		mcpServerRefs,
		mcpServerSnapshots,
	})
	const registry = await capabilityRegistryCache.getOrCreate({
		cacheKey,
		create: () =>
			buildCapabilityRegistryForDynamicSources({
				mcpServerRefs,
				mcpServerSnapshots,
			}),
	})
	let featureFlags = await flagsPromise
	if (
		featureFlags == null &&
		registry.capabilityList.some((capability) => capability.featureFlag)
	) {
		featureFlags = await resolveCallerFeatureFlags(
			input.env,
			input.callerContext,
		)
	}
	return filterRegistryForContext({
		registry,
		callerContext: input.callerContext,
		featureFlags,
	})
}
