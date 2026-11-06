/**
 * Reading secret values on a person's own machine with the Kody CLI
 * (ADR 0096). Only `kody secret get` and `kody run` call this, over HTTP
 * with a `kody_at_` token, so a value never lands in an agent chat. Every
 * read, allowed or refused, is recorded without the value.
 */
import type { OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import type { ApiTokenRecord } from '#worker/api-tokens/service.ts'
import {
	AuthorizationError,
	authorize,
	authorizeCredentialScope,
	computeEffectivePermissions,
	profileChainAllows,
} from '#worker/authorization/authorize.ts'
import { findSecretForUse } from '#mcp/secrets/service.ts'
import { getSecretProviderBinding } from '#mcp/secrets/secret-providers/repo.ts'
import {
	normalizeProviderId,
	resolveProviderSecret,
} from '#mcp/secrets/secret-providers/service.ts'
import { invokeSealedSecretProvider } from '#mcp/secrets/secret-providers/sealed-invoke.ts'
import { loadPersonalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { checkRateLimit } from '#worker/rate-limit.ts'
import {
	credentialResource,
	missingCredentialResource,
} from './credential-ids.ts'
import { authorizePersonalCredentialUse } from './personal-credentials.ts'
import {
	listLocalReadSettings,
	recordLocalReadEvents,
	type LocalReadCommand,
	type LocalReadRefusalReason,
	type NewLocalReadEvent,
} from './local-read-store.ts'

export const localReadPermission: OrgPermission = 'secret:read_local'

/** Starting limits; tune here. Per person per org, per minute. */
export const localReadRateLimits = {
	allowedPerMinute: 300,
	refusedPerMinute: 60,
} as const

export const maxLocalReadNames = 50

export type LocalReadRefusal = {
	name: string
	reason: LocalReadRefusalReason
	message: string
	/** One-step page to turn on local reads for this exact secret. */
	approveUrl: string | null
}

export type LocalReadResult =
	| { ok: true; values: Array<{ name: string; value: string }> }
	| { ok: false; refusals: Array<LocalReadRefusal> }

type ParsedName =
	| { kind: 'secret'; name: string }
	| { kind: 'provider'; name: string; provider: string; ref: string }

const providerNamePattern = /^secret\/([^:]+):(.+)$/

/** `databaseUrl`, or `secret/<provider>:<ref>` for a provider-backed secret. */
export function parseLocalReadName(raw: string): ParsedName {
	const name = raw.trim()
	const provider = providerNamePattern.exec(name)
	if (provider) {
		return {
			kind: 'provider',
			name,
			provider: normalizeProviderId(provider[1] ?? ''),
			ref: (provider[2] ?? '').trim(),
		}
	}
	return { kind: 'secret', name }
}

type Candidate = {
	parsed: ParsedName
	credentialId: string | null
	/** The org that owns the credential: the run org, or the person's own. */
	ownerOrgId: OwnerId | null
	ownerSlug: string | null
	readValue: (() => Promise<string>) | null
	refusal: LocalReadRefusalReason | null
}

const refusalMessages: Record<
	LocalReadRefusalReason,
	(name: string) => string
> = {
	not_found: (name) =>
		`Kody could not find a secret named "${name}" that you can use here.`,
	no_access: (name) => `You do not have access to use the secret "${name}".`,
	local_reads_off: (name) =>
		`Local reads are off for the secret "${name}". A person with write access to it can turn them on from the link below.`,
	token_scope: (name) =>
		`This CLI token cannot read secrets locally, so "${name}" was not read. Sign in with kody login, or ask the agent to mint its token with the secret:read_local scope.`,
	profile_grant: (name) =>
		`The profile this CLI acts as is not allowed to read "${name}" locally. Its owner can check "read locally" for that secret on the profile.`,
	unsupported_secret: (name) =>
		`Only account and org secrets can be read locally, so "${name}" was not read.`,
	rate_limited: (name) =>
		`Too many local reads in the last minute, so "${name}" was not read. Wait a minute and try again.`,
	provider_failed: (name) =>
		`Kody could not fetch "${name}" from its secret provider. Try again, and check the provider on the secret's page if it keeps failing.`,
	other_secret_refused: (name) =>
		`"${name}" was not read because another secret in the same command was refused. Nothing was read.`,
}

function approvalUrl(input: {
	baseUrl: string
	slug: string | null
	credentialId: string | null
}) {
	if (!input.slug || !input.credentialId) return null
	return new URL(
		`/@${encodeURIComponent(input.slug)}/-/credentials/${encodeURIComponent(input.credentialId)}/local-reads`,
		input.baseUrl,
	).toString()
}

/** Interactive `kody login` tokens read toggled secrets without the scope. */
export function tokenAllowsLocalReads(token: ApiTokenRecord) {
	return (
		token.created_via === 'cli-login' ||
		token.scopes.includes(localReadPermission)
	)
}

async function findCandidate(input: {
	env: Env
	baseUrl: string
	request: RequestContext
	parsed: ParsedName
}): Promise<Candidate> {
	const { env, request, parsed } = input
	const orgId = request.org.id
	if (parsed.kind === 'provider') {
		const binding = parsed.provider
			? await getSecretProviderBinding(env.APP_DB, {
					userId: orgId,
					providerId: parsed.provider,
				})
			: null
		try {
			await authorize(
				{ env, request },
				'secret:use',
				binding
					? credentialResource(orgId, {
							id: binding.credentialId,
							name: binding.providerId,
						})
					: missingCredentialResource(orgId, parsed.name),
			)
		} catch (error) {
			if (!(error instanceof AuthorizationError)) throw error
			return refusedCandidate(parsed, binding ? 'no_access' : 'not_found')
		}
		if (!binding || !parsed.ref) return refusedCandidate(parsed, 'not_found')
		return {
			parsed,
			credentialId: binding.credentialId,
			ownerOrgId: orgId,
			ownerSlug: request.org.slug,
			refusal: null,
			readValue: async () => {
				const resolved = await resolveProviderSecret({
					env,
					baseUrl: input.baseUrl,
					userId: orgId,
					request,
					provider: parsed.provider,
					binding,
					ref: parsed.ref,
					invokeProvider: invokeSealedSecretProvider,
				})
				return resolved.value
			},
		}
	}
	const orgLookup = await findSecretForUse({
		env,
		userId: orgId,
		name: parsed.name,
	})
	if (orgLookup.found.found && orgLookup.found.credentialId) {
		const credentialId = orgLookup.found.credentialId
		if (orgLookup.found.scope !== 'user') {
			return refusedCandidate(parsed, 'unsupported_secret', credentialId)
		}
		try {
			await authorize(
				{ env, request },
				'secret:use',
				credentialResource(orgId, { id: credentialId, name: parsed.name }),
			)
		} catch (error) {
			if (!(error instanceof AuthorizationError)) throw error
			return refusedCandidate(parsed, 'no_access', credentialId)
		}
		return {
			parsed,
			credentialId,
			ownerOrgId: orgId,
			ownerSlug: request.org.slug,
			refusal: null,
			readValue: async () => (await orgLookup.readValue()).value ?? '',
		}
	}
	const person = request.actor?.userId
	if (person) {
		const personalOrgId = await loadPersonalOrgIdForPerson(env.APP_DB, person)
		if (personalOrgId !== orgId) {
			const personal = await findSecretForUse({
				env,
				userId: personalOrgId,
				name: parsed.name,
			})
			if (personal.found.found && personal.found.credentialId) {
				const credentialId = personal.found.credentialId
				if (personal.found.scope !== 'user') {
					return refusedCandidate(parsed, 'unsupported_secret', credentialId)
				}
				try {
					authorizeCredentialScope(request, 'secret:use')
					await authorizePersonalCredentialUse({
						db: env.APP_DB,
						actorPersonId: person,
						orgId,
						credentialId,
					})
				} catch (error) {
					if (!(error instanceof AuthorizationError)) throw error
					return refusedCandidate(parsed, 'no_access', credentialId)
				}
				return {
					parsed,
					credentialId,
					ownerOrgId: personalOrgId,
					ownerSlug:
						(await loadOrgBindingForOrg(env.APP_DB, person, personalOrgId))?.org
							.slug ?? null,
					refusal: null,
					readValue: async () => (await personal.readValue()).value ?? '',
				}
			}
		}
	}
	return refusedCandidate(parsed, 'not_found')
}

function refusedCandidate(
	parsed: ParsedName,
	reason: LocalReadRefusalReason,
	credentialId: string | null = null,
): Candidate {
	return {
		parsed,
		credentialId,
		ownerOrgId: null,
		ownerSlug: null,
		readValue: null,
		refusal: reason,
	}
}

/**
 * Reads `names` for the token's person, all or nothing: one refusal reads
 * none of them. Each name is checked for Use, the secret's local reads
 * switch, the token's local read scope, and the profile's "read locally"
 * grant before any value is decrypted or fetched.
 */
export async function readSecretsLocally(input: {
	env: Env
	baseUrl: string
	request: RequestContext
	token: ApiTokenRecord
	names: ReadonlyArray<string>
	command: LocalReadCommand
	ip: string | null
}): Promise<LocalReadResult> {
	const { env, request, token } = input
	const orgId = request.org.id
	const personId = request.actor?.userId ?? null
	const access = await computeEffectivePermissions({ env, request })
	const profileLayer =
		access.profileChain?.layers.find((layer) => layer.self) ?? null
	const parsed = input.names.map(parseLocalReadName)
	const candidates: Array<Candidate> = []
	for (const name of parsed) {
		candidates.push(
			await findCandidate({
				env,
				baseUrl: input.baseUrl,
				request,
				parsed: name,
			}),
		)
	}
	const settings = await listLocalReadSettings(
		env.APP_DB,
		candidates.flatMap((c) => (c.credentialId ? [c.credentialId] : [])),
	)
	const tokenAllows = tokenAllowsLocalReads(token)
	for (const candidate of candidates) {
		if (candidate.refusal || !candidate.credentialId) continue
		if (!settings.get(candidate.credentialId)?.enabled) {
			candidate.refusal = 'local_reads_off'
		} else if (!tokenAllows) {
			candidate.refusal = 'token_scope'
		} else if (
			!profileChainAllows(
				access,
				localReadPermission,
				credentialResource(orgId, {
					id: candidate.credentialId,
					name: candidate.parsed.name,
				}),
			)
		) {
			candidate.refusal = 'profile_grant'
		}
	}
	const rateKey = `local-read:${orgId}:${personId ?? token.id}`
	const anyRefused = candidates.some((c) => c.refusal)
	if (anyRefused) {
		const limit = await checkRateLimit(env.APP_DB, `${rateKey}:refused`, {
			maxRequests: localReadRateLimits.refusedPerMinute,
			windowSeconds: 60,
		})
		if (!limit.allowed) {
			for (const c of candidates) c.refusal = 'rate_limited'
		}
	} else {
		for (let index = 0; index < candidates.length; index += 1) {
			const limit = await checkRateLimit(env.APP_DB, `${rateKey}:allowed`, {
				maxRequests: localReadRateLimits.allowedPerMinute,
				windowSeconds: 60,
			})
			if (!limit.allowed) {
				for (const c of candidates) c.refusal = 'rate_limited'
				break
			}
		}
	}
	const values: Array<{ name: string; value: string }> = []
	if (!candidates.some((c) => c.refusal)) {
		for (const candidate of candidates) {
			try {
				values.push({
					name: candidate.parsed.name,
					value: await (candidate.readValue as () => Promise<string>)(),
				})
			} catch {
				candidate.refusal = 'provider_failed'
				values.length = 0
				break
			}
		}
	}
	const refused = candidates.some((c) => c.refusal)
	if (refused) {
		values.length = 0
		for (const c of candidates) c.refusal ??= 'other_secret_refused'
	}
	const events: Array<NewLocalReadEvent> = candidates.flatMap((c) =>
		c.credentialId
			? [
					{
						orgId: c.ownerOrgId ?? orgId,
						credentialId: c.credentialId,
						actorUserId: personId,
						actorUsername: request.actor?.username ?? null,
						tokenId: token.id,
						tokenName: token.name,
						profileId: profileLayer?.id ?? null,
						profileName: profileLayer?.name ?? null,
						command: input.command,
						ip: input.ip,
						outcome: c.refusal ? ('refused' as const) : ('allowed' as const),
						refusalReason: c.refusal,
					},
				]
			: [],
	)
	await recordLocalReadEvents(env.APP_DB, events)
	if (!refused) return { ok: true, values }
	return {
		ok: false,
		refusals: candidates.map((c) => {
			const reason = c.refusal ?? 'other_secret_refused'
			return {
				name: c.parsed.name,
				reason,
				message: refusalMessages[reason](c.parsed.name),
				approveUrl:
					reason === 'local_reads_off'
						? approvalUrl({
								baseUrl: input.baseUrl,
								slug: c.ownerSlug,
								credentialId: c.credentialId,
							})
						: null,
			}
		}),
	}
}
