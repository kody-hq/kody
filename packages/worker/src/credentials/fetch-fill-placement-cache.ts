/**
 * Side cache so a later fetch-gateway placement of a credential already
 * resolved on this request (body after headers) can still observe would-block
 * without another authorize. Keyed like the fetch-audit cache identity.
 */
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { type CredentialTarget } from './credential-resolver.ts'
import { type CredentialFillPlacement } from './fill-placement.ts'
import { type FillPlacementRefusalLinks } from './fill-placement-enforcement.ts'
import { type PackageStamp } from './package-stamp.ts'

type CachedFillPlacement = {
	placement: CredentialFillPlacement | null
	credentialId: string | null
	refusalLinks: FillPlacementRefusalLinks | null
}

const fillPlacementByActor = new WeakMap<
	RequestContext,
	Map<string, CachedFillPlacement>
>()

export function fetchFillPlacementCacheKey(input: {
	orgId: string
	packageStamp?: PackageStamp | null
	credential: CredentialTarget
}): string | null {
	const { credential } = input
	let identity: string
	switch (credential.use) {
		case 'secret':
			identity = `secret\0${credential.requestHost ?? ''}\0${credential.scope ?? ''}\0${credential.name}`
			break
		case 'integration-token':
			identity = `integration-token\0${credential.requestHost ?? ''}\0${credential.name}\0${credential.packageKodyId ?? ''}`
			break
		case 'provider-secret':
			identity = `provider-secret\0${credential.requestHost ?? ''}\0${credential.provider}\0${credential.ref}`
			break
		case 'package-secret-mount':
		case 'webhook-secret':
		case 'integration-refresh':
		case 'mcp-connection':
		case 'url':
		case 'login':
		case 'signing':
		case 'client-key':
		case 'client-oauth':
		case 'client-oauth-refresh':
			return null
		default: {
			const exhaustive: never = credential
			throw new Error(`Unhandled credential use: ${String(exhaustive)}`)
		}
	}
	const stamp = input.packageStamp
	const stampKey = stamp ? `${stamp.kind}:${stamp.packageId}` : 'none'
	let storageKey = ''
	switch (credential.use) {
		case 'secret':
		case 'provider-secret': {
			const storage = credential.storageContext
			storageKey = `${storage.packageId ?? ''}\0${storage.sessionId ?? ''}\0${storage.appId ?? ''}\0${storage.storageId ?? ''}`
			break
		}
		case 'integration-token':
			storageKey = ''
			break
		default:
			storageKey = ''
			break
	}
	return `${identity}\0${input.orgId}\0${stampKey}\0${storageKey}`
}

export function rememberFetchFillPlacement(input: {
	actor: RequestContext | null
	orgId: string
	packageStamp?: PackageStamp | null
	credential: CredentialTarget
	placement: CredentialFillPlacement | null
	credentialId?: string | null
	refusalLinks?: FillPlacementRefusalLinks | null
}): void {
	const cacheKey = fetchFillPlacementCacheKey(input)
	if (!input.actor || !cacheKey) return
	let byKey = fillPlacementByActor.get(input.actor)
	if (!byKey) {
		byKey = new Map()
		fillPlacementByActor.set(input.actor, byKey)
	}
	byKey.set(cacheKey, {
		placement: input.placement,
		credentialId: input.credentialId ?? null,
		refusalLinks: input.refusalLinks ?? null,
	})
}

export function readFetchFillPlacement(input: {
	actor: RequestContext | null
	orgId: string
	packageStamp?: PackageStamp | null
	credential: CredentialTarget
}): CredentialFillPlacement | null | undefined {
	const cacheKey = fetchFillPlacementCacheKey(input)
	if (!input.actor || !cacheKey) return undefined
	return fillPlacementByActor.get(input.actor)?.get(cacheKey)?.placement
}

export function readFetchFillPlacementCredentialId(input: {
	actor: RequestContext | null
	orgId: string
	packageStamp?: PackageStamp | null
	credential: CredentialTarget
}): string | null | undefined {
	const cacheKey = fetchFillPlacementCacheKey(input)
	if (!input.actor || !cacheKey) return undefined
	return fillPlacementByActor.get(input.actor)?.get(cacheKey)?.credentialId
}

export function readFetchFillPlacementRefusalLinks(input: {
	actor: RequestContext | null
	orgId: string
	packageStamp?: PackageStamp | null
	credential: CredentialTarget
}): FillPlacementRefusalLinks | null {
	const cacheKey = fetchFillPlacementCacheKey(input)
	if (!input.actor || !cacheKey) return null
	return (
		fillPlacementByActor.get(input.actor)?.get(cacheKey)?.refusalLinks ?? null
	)
}
