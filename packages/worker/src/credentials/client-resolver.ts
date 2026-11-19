/**
 * Resolvers for the `credential()` scoped client (ADR 0068): a Key placed by
 * its `inject`, and an OAuth connection's access token as a Bearer header.
 * Each is picked by credential id. The actor's Use (or, for a personal
 * credential, the owner's live grant to the run org) is the only grant;
 * package allowlists and usage modes do not apply. Hosts and HTTPS are
 * checked before any value is read.
 */
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
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
	prepareBodyPlacement,
	type PrepareBodyPlacement,
} from './body-placement.ts'
import { preparePathPlacement } from './path-placement.ts'
import { prepareVaultItemRead } from './vault-item-credential.ts'
import { loginCredentialResolver } from './login-resolver.ts'
import {
	compositionFillSites,
	prepareCredentialComposition,
} from './credential-composition.ts'
import {
	assertHttpsUrl,
	credentialHostsAllow,
	CredentialNotFoundError,
	CredentialRequestRefusedError,
} from './credential-request.ts'
import {
	authorizeActorPersonalUse,
	authorizeActorUse,
	permissionForUse,
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
import {
	fillSiteFromCredentialInject,
	type CredentialFillSite,
} from './fill-placement.ts'
import {
	authorizeStoredCredential,
	findStoredCredential,
	type StoredCredentialLookup,
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
		case 'body':
			return 'JSON body'
		case 'path':
			return 'URL path'
		case 'composition':
			return 'approved credential composition'
		default: {
			const exhaustive: never = inject
			throw new Error(`Unhandled inject: ${String(exhaustive)}`)
		}
	}
}

export function placeByInject(
	inject: Exclude<CredentialInject, { kind: 'body' | 'path' | 'composition' }>,
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
		let placeBody: PrepareBodyPlacement | null = null
		let placePath: ReturnType<typeof preparePathPlacement> | null = null
		let compose: Awaited<
			ReturnType<typeof prepareCredentialComposition>
		> | null = null
		let readValue: (() => Promise<string>) | null = null
		const members = new Map<string, () => Promise<string>>()
		const connections = new Map<
			string,
			() => Promise<ResolvedClientPlacement>
		>()
		async function assertFill(
			found: NonNullable<StoredCredentialLookup>['found'],
			sites: ReadonlyArray<CredentialFillSite>,
			approved: boolean,
		) {
			const placement = await resolveEffectiveFillPlacement({
				db: call.input.env.APP_DB,
				credentialId: found.credentialId,
				stored: found.placement,
			})
			try {
				enforceFillPlacement({
					env: call.input.env,
					credentialName: found.name,
					credentialId: found.credentialId,
					slot: null,
					placement,
					sites,
					surface: 'credential-client',
				})
			} catch (error) {
				if (!(error instanceof SecretPlacementError)) throw error
				throw new CredentialRequestRefusedError(
					'invalid_request',
					approved
						? 'The credential owner must approve this request placement.'
						: error.message,
				)
			}
		}
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
				readValue = await prepareVaultItemRead(call, found, lookup!.readValue)
				inject = readCredentialInject(found.injectJson)
				if (!inject) {
					throw new CredentialRequestRefusedError(
						'invalid_request',
						"This credential's inject is not set up correctly. Its manager can fix it with credentialUpdate.",
					)
				}
				const approved =
					inject.kind === 'body' ||
					inject.kind === 'path' ||
					inject.kind === 'composition'
				if (
					inject.kind === 'body' ||
					inject.kind === 'path' ||
					inject.kind === 'composition'
				) {
					// Request placements are tracked by category, not by credential label,
					// field, resource, or destination.
					call.subject.name = inject.kind
					call.subject.details = { placement: inject.kind }
					if (
						!credential.outboundRequest ||
						credential.attestedPackageId !== inject.packageId
					) {
						throw new CredentialRequestRefusedError(
							'invalid_request',
							'This credential placement requires its approved package.',
						)
					}
				}
				if (inject.kind === 'composition') {
					if (inject.entryCredentialId !== credential.credentialId) {
						throw new CredentialRequestRefusedError(
							'invalid_request',
							'Use the need mapped to the entry credential.',
						)
					}
					compose = await prepareCredentialComposition(
						inject,
						credential.outboundRequest!,
					)
					for (const site of inject.sites) {
						if (site.kind !== 'connection') continue
						const subject = {
							...call.subject,
							name: 'composition',
							credentialId: null,
							companions: undefined,
							resourceType:
								site.connection === 'oauth'
									? ('integration' as const)
									: ('secret' as const),
						}
						;(call.subject.companions ??= []).push(subject)
						const requestUrl = credential.requestUrl
						const refuse = () =>
							new CredentialRequestRefusedError(
								'invalid_request',
								'An approved connection is unavailable.',
							)
						if (site.connection === 'oauth') {
							const target = {
								...call,
								subject,
								credential: {
									use: 'client-oauth' as const,
									requestUrl,
									credentialId: site.credentialId,
								},
							}
							const connection = await findOauthConnection(
								target,
								site.credentialId,
							)
							if (connection?.owner !== found.ownerId) throw refuse()
							const handle = oauthHandle(target, connection)
							await handle.authorize()
							subject.name = 'composition'
							connections.set(site.credentialId, handle.apply)
						} else {
							const login = await findStoredCredential(call, site.credentialId)
							if (login?.found.ownerId !== found.ownerId) throw refuse()
							const handle = await loginCredentialResolver.resolve({
								...call,
								subject,
								credential: {
									use: 'login',
									requestUrl,
									credentialId: site.credentialId,
									expectedInject: site.inject,
								},
							})
							await handle.authorize()
							subject.name = 'composition'
							connections.set(site.credentialId, async () => ({
								...(await handle.apply()),
								shape: 'approved login session',
							}))
						}
					}
					for (const [id, sites] of compositionFillSites(inject)) {
						if (id === credential.credentialId) {
							await assertFill(found, sites, true)
							members.set(id, readValue)
							continue
						}
						const memberSubject = {
							...call.subject,
							name: 'composition',
							credentialId: null,
							companions: undefined,
						}
						;(call.subject.companions ??= []).push(memberSubject)
						const other = await findStoredCredential(call, id)
						const member = await authorizeStoredCredential(
							{ ...call, subject: memberSubject },
							id,
							other,
							'secret',
						)
						memberSubject.name = 'composition'
						if (
							member.ownerId !== found.ownerId ||
							JSON.stringify(readCredentialInject(member.injectJson)) !==
								JSON.stringify(inject)
						) {
							throw new CredentialRequestRefusedError(
								'invalid_request',
								'Every credential must approve this same request composition.',
							)
						}
						assertRequestOnHosts(
							member.allowedHosts,
							credential.requestUrl,
							'An approved credential',
						)
						await assertFill(member, sites, true)
						members.set(
							id,
							await prepareVaultItemRead(call, member, other!.readValue),
						)
					}
					return
				}
				await assertFill(
					found,
					[fillSiteFromCredentialInject(inject)],
					approved,
				)
				if (inject.kind === 'body') {
					placeBody = await prepareBodyPlacement(
						inject,
						credential.outboundRequest!,
					)
				} else if (inject.kind === 'path') {
					placePath = preparePathPlacement(inject, credential.outboundRequest!)
				}
			},
			async apply() {
				if (compose) {
					const values = new Map<string, string>()
					for (const [id, read] of members) values.set(id, await read())
					const redactions: Array<string> = []
					for (const [id, read] of connections) {
						const { placement, substitutedValues } = await read()
						if (placement.kind !== 'header' && placement.kind !== 'query') {
							throw new CredentialRequestRefusedError(
								'invalid_request',
								'The approved connection placement changed.',
							)
						}
						values.set(id, placement.value)
						redactions.push(...substitutedValues)
					}
					return compose(values, redactions)
				}
				const value = await readValue!()
				if (inject!.kind === 'composition')
					throw new Error('Composition was not prepared.')
				if (inject!.kind === 'path') {
					const { url, substitutedValues } = placePath!(value)
					return {
						placement: { kind: 'path', url },
						substitutedValues,
						shape: 'URL path',
					}
				}
				if (inject!.kind !== 'body') return placeByInject(inject!, value)
				const { body, sealed, substitutedValues } = placeBody!(value)
				return {
					placement: { kind: 'body', body, sealed },
					substitutedValues,
					shape: 'JSON body',
				}
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
		runOrgId: input.orgId,
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
		await authorizeActorPersonalUse({
			env: call.input.env,
			actor: call.input.actor,
			orgId: call.input.orgId,
			credentialId: connection.id,
			name: connection.name,
			permission: permissionForUse(call.credential.use),
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

function oauthHandle(
	call: ResolverCall<CredentialTargetFor<'client-oauth'>>,
	found: OauthConnection | null,
) {
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
		return oauthHandle(
			call,
			await findOauthConnection(call, call.credential.credentialId),
		)
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
