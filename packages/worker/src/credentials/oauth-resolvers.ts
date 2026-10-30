/**
 * Resolvers for OAuth integrations. Use, the package's usage mode, and the
 * integration's hosts are checked before the token is read, so a refused
 * host never triggers a token refresh.
 */
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { loadPersonalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import {
	createMissingIntegrationAccessTokenMessage,
	findIntegrationCredentialId,
	resolveIntegrationAccessToken,
} from '#worker/integrations/credentials.ts'
import { assertCanUseIntegration } from '#worker/integrations/package-access.ts'
import { getIntegrationFillPlacement } from '#worker/integrations/repo.ts'
import { getJoinedIntegration } from '#worker/integrations/service.ts'
import { refreshIntegrationTokens } from '#worker/integrations/token-refresh.ts'
import { assertIntegrationAllowsHost } from '#mcp/execute-modules/integration-host-allowlist.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	assertActorScopeAllowsCredential,
	authorizeActorUse,
	type CredentialResolver,
	type CredentialTargetFor,
	type ResolverCall,
} from './credential-resolver.ts'
import { rememberFetchFillPlacement } from './fetch-fill-placement-cache.ts'
import {
	enforceFillPlacement,
	resolveEffectiveFillPlacement,
	type FillPlacementRefusalLinks,
	refusalLinkOrgSlug,
} from './fill-placement-enforcement.ts'
import {
	authorizePersonalCredentialUse,
	loadPinnedOrgId,
} from './personal-credentials.ts'

export type IntegrationNameLookup = {
	owner: 'org' | 'personal'
	ownerId: OwnerId
	credentialId: string | null
}

/**
 * Use check for a granted personal connection: the actor's token scope must
 * allow `integration:use`, and only the owner may use it through a live
 * grant to the run org (Owners and Automation included in the refusal).
 */
export async function authorizePersonalIntegrationLookup(input: {
	env: Pick<Env, 'APP_DB'>
	orgId: OwnerId
	actor: RequestContext | null | undefined
	credentialId: string | null
	name: string
}) {
	assertActorScopeAllowsCredential(
		{
			actor: input.actor,
			orgId: input.orgId,
			credentialId: input.credentialId,
			name: input.name,
		},
		'integration:use',
	)
	await authorizePersonalCredentialUse({
		db: input.env.APP_DB,
		actorPersonId: input.actor?.actor?.userId ?? null,
		orgId: input.orgId,
		credentialId: input.credentialId ?? '',
	})
}

async function authorizeIntegrationUse(
	call: ResolverCall<
		CredentialTargetFor<'integration-token' | 'integration-refresh'>
	>,
	lookup: IntegrationNameLookup,
) {
	const { input, credential } = call
	switch (lookup.owner) {
		case 'org':
			await authorizeActorUse(call, lookup.credentialId)
			break
		case 'personal':
			call.subject.credentialId = lookup.credentialId
			await authorizePersonalIntegrationLookup({
				env: input.env,
				orgId: input.orgId,
				actor: input.actor,
				credentialId: lookup.credentialId,
				name: call.subject.name,
			})
			break
		default: {
			const exhaustive: never = lookup.owner
			throw new Error(`Unhandled integration owner: ${String(exhaustive)}`)
		}
	}
	await assertCanUseIntegration({
		env: input.env,
		baseUrl: input.baseUrl,
		// Package allowlists live on the credential's owning org (run org or
		// the actor's personal org for a granted personal connection).
		userId: lookup.ownerId,
		name: credential.name,
		packageId: input.packageStamp?.packageId ?? null,
		packageKodyId: credential.packageKodyId,
	})
}

/**
 * Tokens are read by name, so a connection replaced after the Use check
 * could hand over the replacement's token. Refuse when the name no longer
 * names the credential that was authorized.
 */
async function assertIntegrationUnchanged(
	call: ResolverCall<
		CredentialTargetFor<'integration-token' | 'integration-refresh'>
	>,
	lookup: IntegrationNameLookup,
) {
	const current = await findIntegrationCredentialId({
		env: call.input.env,
		userId: lookup.ownerId,
		name: call.credential.name,
	})
	if (current !== lookup.credentialId) {
		throw new Error(
			createMissingIntegrationAccessTokenMessage(call.credential.name),
		)
	}
}

/** Org integration by name, else the actor's granted personal one. */
function findIntegrationByName(
	call: ResolverCall<
		CredentialTargetFor<'integration-token' | 'integration-refresh'>
	>,
): Promise<IntegrationNameLookup> {
	return findIntegrationLookupByName({
		env: call.input.env,
		orgId: call.input.orgId,
		actor: call.input.actor,
		name: call.credential.name,
	})
}

/**
 * The one name lookup for integration tokens: the run org's connection
 * first; when none, the actor's own personal-org connection of that name.
 * A personal hit is only a candidate; authorize it with
 * `authorizePersonalIntegrationLookup` before use.
 */
export async function findIntegrationLookupByName(input: {
	env: Pick<Env, 'APP_DB'>
	orgId: OwnerId
	actor: RequestContext | null | undefined
	name: string
}): Promise<IntegrationNameLookup> {
	const orgCredentialId = await findIntegrationCredentialId({
		env: input.env,
		userId: input.orgId,
		name: input.name,
	})
	// A personal connection pinned to another org's app is never an org
	// credential of its own (personal) org; the personal path decides.
	if (
		orgCredentialId &&
		!(await loadPinnedOrgId(input.env.APP_DB, input.orgId, orgCredentialId))
	) {
		return { owner: 'org', ownerId: input.orgId, credentialId: orgCredentialId }
	}
	const person = input.actor?.actor?.userId
	if (!person) {
		return { owner: 'org', ownerId: input.orgId, credentialId: null }
	}
	const personalOwner = await loadPersonalOrgIdForPerson(
		input.env.APP_DB,
		person,
	)
	const personalId = await findIntegrationCredentialId({
		env: input.env,
		userId: personalOwner,
		name: input.name,
	})
	if (personalId) {
		return {
			owner: 'personal',
			ownerId: personalOwner,
			credentialId: personalId,
		}
	}
	return { owner: 'org', ownerId: input.orgId, credentialId: null }
}

export const integrationTokenResolver: CredentialResolver<'integration-token'> =
	{
		auditSubject: (credential) => ({
			use: credential.use,
			resourceType: 'integration',
			name: credential.name,
			credentialId: null,
			details: { host: credential.requestHost ?? null },
		}),
		async resolve(call) {
			const { input, credential } = call
			const lookup = await findIntegrationByName(call)
			return {
				async authorize() {
					await authorizeIntegrationUse(call, lookup)
					if (credential.fillSites && credential.fillSites.length > 0) {
						const placement = await resolveEffectiveFillPlacement({
							db: input.env.APP_DB,
							credentialId: lookup.credentialId,
							stored: await getIntegrationFillPlacement({
								db: input.env.APP_DB,
								userId: lookup.ownerId,
								name: credential.name,
							}),
						})
						const refusalLinks: FillPlacementRefusalLinks | null =
							lookup.owner === 'org'
								? {
										baseUrl: input.baseUrl,
										orgSlug: refusalLinkOrgSlug({
											actor: call.input.actor,
											orgId: call.input.orgId,
										}),
									}
								: null
						rememberFetchFillPlacement({
							actor: call.input.actor,
							orgId: call.input.orgId,
							packageStamp: call.input.packageStamp,
							credential,
							placement,
							credentialId: lookup.credentialId,
							refusalLinks,
						})
						enforceFillPlacement({
							env: call.input.env,
							credentialName: credential.name,
							credentialId: lookup.credentialId,
							slot: credential.name,
							placement,
							sites: credential.fillSites,
							surface: 'placeholder',
							links: refusalLinks,
						})
					}
					if (!credential.requestHost) return
					const joined = await getJoinedIntegration({
						env: input.env,
						userId: lookup.ownerId,
						name: credential.name,
					})
					if (!joined) {
						throw new Error(
							createMissingIntegrationAccessTokenMessage(credential.name),
						)
					}
					assertIntegrationAllowsHost(
						credential.name,
						{
							requiredHosts: joined.connection.requiredHosts,
							apiBaseUrl: joined.app.apiBaseUrl,
						},
						credential.requestHost,
					)
				},
				async apply() {
					const resolved = await resolveIntegrationAccessToken({
						env: input.env,
						userId: lookup.ownerId,
						name: credential.name,
					})
					await assertIntegrationUnchanged(call, lookup)
					return resolved?.accessToken ?? null
				},
			}
		},
		isFound: (token) => token !== null,
	}

export const integrationRefreshResolver: CredentialResolver<'integration-refresh'> =
	{
		auditSubject: (credential) => ({
			use: credential.use,
			resourceType: 'integration',
			name: credential.name,
			credentialId: null,
		}),
		async resolve(call) {
			const { input, credential } = call
			const lookup = await findIntegrationByName(call)
			return {
				authorize: () => authorizeIntegrationUse(call, lookup),
				async apply() {
					// A refresh hands back no token. Checking first keeps an old
					// grant from refreshing a replacement connection; checking
					// after keeps it from being told a replacement swapped in
					// mid-refresh was refreshed for it.
					await assertIntegrationUnchanged(call, lookup)
					const result = await refreshIntegrationTokens({
						env: input.env,
						userId: lookup.ownerId,
						userEmail: credential.userEmail,
						name: credential.name,
						waitUntil: credential.waitUntil,
					})
					await assertIntegrationUnchanged(call, lookup)
					return result
				},
			}
		},
		isFound: () => true,
	}
