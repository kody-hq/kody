/**
 * Resolvers for the `credential()` scoped client (ADR 0068): a Key placed by
 * its `inject`, and an OAuth connection's access token as a Bearer header.
 * Each is picked by credential id. The actor's Use (or, for a personal
 * credential, the owner's live grant to the run org) is the only grant;
 * package allowlists and usage modes do not apply. Hosts and HTTPS are
 * checked before any value is read.
 */
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { loadPersonalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import {
	createMissingIntegrationAccessTokenMessage,
	findIntegrationCredentialId,
	resolveIntegrationAccessToken,
} from '#worker/integrations/credentials.ts'
import { refreshIntegrationTokens } from '#worker/integrations/token-refresh.ts'
import {
	findCredentialById,
	type UsableCredential,
} from './credential-candidates.ts'
import {
	readCredentialInject,
	type CredentialInject,
} from './credential-fields.ts'
import {
	assertHttpsUrl,
	credentialHostsAllow,
	CredentialNotFoundError,
	CredentialRequestRefusedError,
} from './credential-request.ts'
import {
	authorizeActorUse,
	type ClientPlacement,
	type CredentialResolver,
	type CredentialTargetFor,
	type ResolvedClientPlacement,
	type ResolverCall,
} from './credential-resolver.ts'
import { SecretPlacementError } from '#mcp/secrets/secret-placement.ts'
import {
	enforceFillPlacement,
	resolveEffectiveFillPlacement,
} from './fill-placement-enforcement.ts'
import { fillSiteFromCredentialInject } from './fill-placement.ts'
import { authorizePersonalCredentialUse } from './personal-credentials.ts'
import {
	authorizeStoredCredential,
	findStoredCredential,
} from './stored-credential.ts'

/** The inject shape with no value: `header Authorization Bearer`. */
export function describeInjectShape(inject: CredentialInject) {
	switch (inject.kind) {
		case 'header': {
			const scheme = inject.format.replace('{value}', '').trim()
			return scheme
				? `header ${inject.name} ${scheme}`
				: `header ${inject.name}`
		}
		case 'basic':
			return `basic (value as ${inject.valueAs})`
		case 'query':
			return `query ${inject.param}`
		default: {
			const exhaustive: never = inject
			throw new Error(`Unhandled inject: ${String(exhaustive)}`)
		}
	}
}

export function placeByInject(
	inject: CredentialInject,
	value: string,
): ResolvedClientPlacement {
	const shape = describeInjectShape(inject)
	switch (inject.kind) {
		case 'header': {
			const header = inject.format.replace('{value}', () => value)
			return {
				placement: { kind: 'header', name: inject.name, value: header },
				substitutedValues: [...new Set([value, header])],
				shape,
			}
		}
		case 'basic': {
			const pair =
				inject.valueAs === 'username'
					? `${value}:${inject.other}`
					: `${inject.other}:${value}`
			const encoded = bytesToBase64(new TextEncoder().encode(pair))
			const placement: ClientPlacement = {
				kind: 'header',
				name: 'Authorization',
				value: `Basic ${encoded}`,
			}
			return {
				placement,
				substitutedValues: [...new Set([value, encoded, placement.value])],
				shape,
			}
		}
		case 'query':
			return {
				placement: { kind: 'query', param: inject.param, value },
				substitutedValues: [value],
				shape,
			}
		default: {
			const exhaustive: never = inject
			throw new Error(`Unhandled inject: ${String(exhaustive)}`)
		}
	}
}

function assertRequestOnHosts(
	hosts: ReadonlyArray<string>,
	requestUrl: URL,
	label: string,
) {
	assertHttpsUrl(requestUrl)
	if (hosts.length === 0) {
		throw new CredentialRequestRefusedError(
			'host_not_allowed',
			'This credential has no hosts, so it is not sent anywhere.',
		)
	}
	if (!credentialHostsAllow(hosts, requestUrl.hostname)) {
		throw new CredentialRequestRefusedError(
			'host_not_allowed',
			`${label} is not sent to ${requestUrl.hostname}; that host is not one of its hosts.`,
		)
	}
}

export const clientKeyResolver: CredentialResolver<'client-key'> = {
	auditSubject: (credential) => ({
		use: credential.use,
		resourceType: 'secret',
		name: credential.credentialId,
		credentialId: null,
		details: { host: credential.requestUrl.hostname },
	}),
	async resolve(call) {
		const { credential } = call
		const lookup = await findStoredCredential(call, credential.credentialId)
		let inject: CredentialInject | null = null
		return {
			async authorize() {
				const found = await authorizeStoredCredential(
					call,
					credential.credentialId,
					lookup,
					'secret',
				)
				assertRequestOnHosts(
					found.allowedHosts,
					credential.requestUrl,
					'This credential',
				)
				inject = readCredentialInject(found.injectJson)
				if (!inject) {
					throw new CredentialRequestRefusedError(
						'invalid_request',
						"This credential's inject is not set up correctly. Its manager can fix it with credentialUpdate.",
					)
				}
				const placement = await resolveEffectiveFillPlacement({
					db: call.input.env.APP_DB,
					credentialId: credential.credentialId,
					stored: found.placement,
				})
				try {
					enforceFillPlacement({
						env: call.input.env,
						credentialName: found.name,
						credentialId: credential.credentialId,
						slot: null,
						placement,
						sites: [fillSiteFromCredentialInject(inject)],
						surface: 'credential-client',
					})
				} catch (error) {
					if (!(error instanceof SecretPlacementError)) throw error
					throw new CredentialRequestRefusedError(
						'invalid_request',
						error.message,
					)
				}
			},
			async apply() {
				// `authorize` returned, so the lookup and inject are set.
				return placeByInject(inject!, await lookup!.readValue())
			},
		}
	},
	isFound: () => true,
}

type OauthConnection = {
	owner: OwnerId
	connection: UsableCredential
}

/** The connection in the run org, else the actor's own personal one. */
async function findOauthConnection(
	call: ResolverCall,
	credentialId: string,
): Promise<OauthConnection | null> {
	const { input } = call
	const org = await findCredentialById({
		db: input.env.APP_DB,
		ownerId: input.orgId,
		id: credentialId,
		scope: 'org',
	})
	if (org) return { owner: input.orgId, connection: org }
	const person = input.actor?.actor?.userId
	if (!person) return null
	const owner = await loadPersonalOrgIdForPerson(input.env.APP_DB, person)
	const personal = await findCredentialById({
		db: input.env.APP_DB,
		ownerId: owner,
		id: credentialId,
		scope: 'personal',
	})
	return personal ? { owner, connection: personal } : null
}

async function authorizeOauthConnection(
	call: ResolverCall<
		CredentialTargetFor<'client-oauth' | 'client-oauth-refresh'>
	>,
	found: OauthConnection | null,
) {
	const { credentialId } = call.credential
	if (!found) {
		await authorizeActorUse(call, null, credentialId)
		throw new CredentialNotFoundError()
	}
	const { connection } = found
	if (connection.expired) throw new CredentialNotFoundError()
	call.subject.name = connection.name
	if (connection.scope === 'org') {
		await authorizeActorUse(call, connection.id, connection.name)
	} else {
		call.subject.credentialId = connection.id
		await authorizePersonalCredentialUse({
			db: call.input.env.APP_DB,
			actorPersonId: call.input.actor?.actor?.userId ?? null,
			orgId: call.input.orgId,
			credentialId: connection.id,
		})
	}
	if (connection.kind !== 'oauth') throw new CredentialNotFoundError()
}

/**
 * Tokens are read by name, so a connection replaced after the Use check
 * could hand over the replacement's token. Refuse when the name no longer
 * names the authorized connection.
 */
async function assertConnectionUnchanged(
	call: ResolverCall,
	found: OauthConnection,
) {
	const current = await findIntegrationCredentialId({
		env: call.input.env,
		userId: found.owner,
		name: found.connection.name,
	})
	if (current !== found.connection.id) {
		throw new Error(
			createMissingIntegrationAccessTokenMessage(found.connection.name),
		)
	}
}

export const clientOauthResolver: CredentialResolver<'client-oauth'> = {
	auditSubject: (credential) => ({
		use: credential.use,
		resourceType: 'integration',
		name: credential.credentialId,
		credentialId: null,
		details: { host: credential.requestUrl.hostname },
	}),
	async resolve(call) {
		const found = await findOauthConnection(call, call.credential.credentialId)
		return {
			async authorize() {
				await authorizeOauthConnection(call, found)
				assertRequestOnHosts(
					found!.connection.hosts,
					call.credential.requestUrl,
					'This connection',
				)
			},
			async apply() {
				const resolved = await resolveIntegrationAccessToken({
					env: call.input.env,
					userId: found!.owner,
					name: found!.connection.name,
				})
				await assertConnectionUnchanged(call, found!)
				if (!resolved?.accessToken) {
					throw new Error(
						createMissingIntegrationAccessTokenMessage(found!.connection.name),
					)
				}
				return placeByInject(
					{ kind: 'header', name: 'Authorization', format: 'Bearer {value}' },
					resolved.accessToken,
				)
			},
		}
	},
	isFound: () => true,
}

export const clientOauthRefreshResolver: CredentialResolver<'client-oauth-refresh'> =
	{
		auditSubject: (credential) => ({
			use: credential.use,
			resourceType: 'integration',
			name: credential.credentialId,
			credentialId: null,
		}),
		async resolve(call) {
			const found = await findOauthConnection(
				call,
				call.credential.credentialId,
			)
			return {
				authorize: () => authorizeOauthConnection(call, found),
				async apply() {
					await assertConnectionUnchanged(call, found!)
					const result = await refreshIntegrationTokens({
						env: call.input.env,
						userId: found!.owner,
						userEmail: call.credential.userEmail,
						name: found!.connection.name,
						waitUntil: call.credential.waitUntil,
					})
					await assertConnectionUnchanged(call, found!)
					return { refreshed: result.refreshed }
				},
			}
		},
		isFound: () => true,
	}
