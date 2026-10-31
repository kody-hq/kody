/**
 * The host half of the `credential()` scoped client (ADR 0068).
 *
 * `openCredentialClient` resolves a need key (or an exact name) to one
 * credential the actor can Use and returns a signed, run-scoped handle with
 * the credential's name, scope, kind, and hosts. It reads no value. Every use
 * of the handle (a gateway fetch, `sign`, `callTool`, an OAuth refresh) goes
 * through `resolveCredential`, which authorizes and audits it again.
 *
 * Errors are structured: a `code` from the ADR's table and `retryWith`, a
 * list of ready-to-retry picks (empty when there is nothing to retry with).
 * No error carries a value, and option lists hold only credentials the actor
 * can Use.
 */
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { McpCallerError } from '#mcp/caller-error.ts'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	isFetchCapableCredentialKind,
	packageCredentialKindValues,
	type PackageCredentialKind,
} from '#worker/package-registry/types.ts'
import { enablementIdOf } from '#worker/request-context/request-context.ts'
import {
	buildCredentialCreateUrl,
	type CredentialCreateLinkInput,
} from '#universal/credential-contracts.ts'
import { buildNeedCreateUrl } from './need-create-url.ts'
import {
	assertCredentialUsesDeclared,
	CredentialNeedUndeclaredError,
	type credentialNeedUndeclaredCode,
	isPackageCredentialUseLimited,
} from './credential-need-enforcement.ts'
import {
	CredentialClientHandleError,
	signCredentialClientHandle,
	verifyCredentialClientHandle,
	type CredentialClientHandle,
} from './credential-client-handle.ts'
import {
	findCredentialById,
	listUsableCredentials,
	liveUsableCredentials,
	resolveNeedCandidates,
	type UsableCredential,
} from './credential-candidates.ts'
import {
	type CredentialCallMap,
	type CredentialPick,
} from './credential-call-map.ts'
import {
	type CredentialMappingRowTarget,
	loadCredentialMappings,
	resolveStoredMapping,
} from './credential-mappings.ts'
import {
	loadPackageNeeds,
	mappedCredentialFits,
	type NeedTarget,
	needTarget,
} from './credential-need-fit.ts'
import {
	savedCredentialNeeds,
	type SavedCredentialNeed,
} from './credential-needs.ts'
import {
	CredentialLoginFailedError,
	CredentialLoginNeedsReconnectError,
	CredentialLoginRetryLaterError,
	CredentialNotFoundError,
	CredentialRequestRefusedError,
} from './credential-request.ts'
import {
	type CredentialTarget,
	type ResolvedClientPlacement,
	type ResolveCredentialInput,
} from './credential-resolver.ts'
import { resolveCredential } from './resolve-credential.ts'
import { type SigningOperation } from './signing-resolver.ts'
import { findPackageAppGrantCredentialMapping } from '#app/package-app-oauth-grants.ts'

export type CredentialClientErrorCode =
	| 'credential_unbound'
	| 'credential_ambiguous'
	| 'credential_not_found'
	| 'credential_denied'
	| 'credential_rate_limited'
	| 'credential_need_unknown'
	| typeof credentialNeedUndeclaredCode
	| 'host_not_allowed'
	| 'insecure_transport'
	| 'invalid_request'
	| 'login_failed'
	| 'login_retry_later'
	| 'login_needs_reconnect'

export type CredentialClientOption = {
	name: string
	scope: UsableCredential['scope']
	kind: PackageCredentialKind
	hosts: Array<string>
}

/** One ready-to-retry pick: a call-map entry, or `credential.named`. */
export type CredentialClientRetry = {
	credentials?: Record<
		string,
		{ name: string; scope: UsableCredential['scope'] }
	>
	named?: { name: string; scope: UsableCredential['scope'] }
}

export type CredentialClientErrorBody = {
	code: CredentialClientErrorCode
	message: string
	retryWith: Array<CredentialClientRetry>
	options?: Array<CredentialClientOption>
	possibleMatches?: Array<CredentialClientOption>
	/** Absolute creation link; always set for unbound, ambiguous, and not-found errors. */
	createUrl?: string
	/** Seconds until a login's exchange may run again after it failed. */
	retryAfterSeconds?: number
}

export class CredentialClientError extends McpCallerError {
	readonly body: CredentialClientErrorBody
	constructor(body: CredentialClientErrorBody) {
		// The code leads the message so a fetch rejection, which carries only
		// the message, still says which error it is.
		super(`[${body.code}] ${body.message}`)
		this.name = 'CredentialClientError'
		this.body = body
	}
}

function refusal(
	code: CredentialClientErrorCode,
	message: string,
	extra: Partial<CredentialClientErrorBody> = {},
) {
	// The link rides in the message too: a fetch rejection carries only that.
	const text = extra.createUrl
		? `${message} Create one at ${extra.createUrl}`
		: message
	return new CredentialClientError({
		code,
		message: text,
		retryWith: [],
		...extra,
	})
}

/**
 * The structured error for a failure from the door, else null. With a
 * `baseUrl`, a not-found error from the door carries a creation link for
 * `orgSlug`'s org.
 */
export function toCredentialClientError(
	error: unknown,
	options: { baseUrl?: string; orgSlug?: string | null } = {},
) {
	if (error instanceof CredentialClientError) return error
	if (error instanceof CredentialNeedUndeclaredError) {
		return refusal(error.code, error.detail)
	}
	if (error instanceof CredentialRequestRefusedError) {
		return refusal(error.code, error.message)
	}
	if (error instanceof CredentialNotFoundError) {
		return refusal(
			'credential_not_found',
			error.message,
			options.baseUrl
				? {
						createUrl: buildCredentialCreateUrl(options.baseUrl, {
							orgSlug: options.orgSlug,
						}),
					}
				: {},
		)
	}
	if (error instanceof CredentialLoginRetryLaterError) {
		return refusal('login_retry_later', error.message, {
			retryAfterSeconds: error.retryAfterSeconds,
		})
	}
	if (error instanceof CredentialLoginNeedsReconnectError) {
		return refusal('login_needs_reconnect', error.message)
	}
	if (error instanceof CredentialLoginFailedError) {
		return refusal(
			'login_failed',
			error.message,
			error.retryAfterSeconds === null
				? {}
				: { retryAfterSeconds: error.retryAfterSeconds },
		)
	}
	if (error instanceof CredentialClientHandleError) {
		return refusal('invalid_request', error.message)
	}
	if (error instanceof AuthorizationError) {
		return refusal('credential_denied', error.message)
	}
	return null
}

/** What every client call needs from the run. */
export type CredentialClientContext = {
	env: Env
	callerContext: McpCallerContext
	/** The run (or CapabilityProxy credential) handles are bound to. */
	binding: string
	/** The package whose needs and sharing apply, or null for ad hoc code. */
	packageId: string | null
	/** The caller's picks for this run, by need key. */
	callMap?: CredentialCallMap | null
	/**
	 * The run's pinned needs as `validateCredentialCallMap` sees them. When
	 * set, a key missing here reads as a provider: a package's latest publish
	 * never adds needs the run's entry closures did not pin.
	 */
	runNeeds?: () => Promise<ReadonlyMap<string, SavedCredentialNeed>>
	/**
	 * The run's entry packages, from the host (run package context or a
	 * host-signed binding), never from sandbox arguments. Stored mappings and
	 * creation links for a need use the entry whose closure pins it, so a
	 * dependency's `credential(key)` reads the entry package's mappings (ADR
	 * 0068 amendment 2026-10-27). Unset means the calling package's own.
	 */
	runEntries?: () => Promise<RunCredentialEntries | null>
	/**
	 * Package-app runs only (ADR 0068 amendment 2026-10-24): how new handles
	 * are stamped, and who a stamped handle resolves as on each use.
	 */
	packageAppAuthority?: PackageAppCredentialAuthority | null
	waitUntil?: (promise: Promise<unknown>) => void
}

type PackageAppCredentialHandleIssue =
	| { runsAs: true }
	| { visitorNeed: string }
	| { executorNeed: string }

export type PackageAppCredentialAuthority = {
	/** Opened as the app's runs-as person, or on a visitor's own need. */
	issue: { runsAs: true } | { visitorNeed: string } | null
	/** The live runs-as person, or null when nobody runs the app. */
	runsAsRequest: () => Promise<RequestContext | null>
	/** The visitor, or null unless their live consent covers `needKey`. */
	visitorNeedRequest: (needKey: string) => Promise<RequestContext | null>
	visitorNeedGrant: (
		needKey: string,
	) => Promise<{ request: RequestContext; grantId: string } | null>
	/** The org that owns the app: checks declarations with no acting request. */
	orgId?: string
}

export type OpenedCredentialClient = {
	handle: string
	key: string | null
	name: string
	scope: UsableCredential['scope']
	kind: PackageCredentialKind
	hosts: Array<string>
	/** Set when an explicit pick has no provider and could resolve on its own. */
	hint?: string
}

type Picked = {
	credential: UsableCredential
	hint: string | null
	packageAppIssue?: PackageAppCredentialHandleIssue | null
	packageAppRequest?: RequestContext
}

const maxKeyLength = 100

function requireActorRequest(ctx: CredentialClientContext): RequestContext {
	const request = ctx.callerContext.request
	if (!request?.actor) {
		throw refusal(
			'credential_denied',
			'Credentials resolve only for a person. This run has no acting person.',
		)
	}
	return request
}

function readText(value: unknown, field: string) {
	const text = typeof value === 'string' ? value.trim() : ''
	if (!text || text.length > maxKeyLength) {
		throw refusal(
			'invalid_request',
			`${field} must be a non-empty string of at most ${maxKeyLength} characters.`,
		)
	}
	return text
}

function readScope(value: unknown): CredentialPick['scope'] {
	if (value == null) return null
	if (value === 'org' || value === 'personal') return value
	throw refusal('invalid_request', 'scope must be "org" or "personal".')
}

function toOption(credential: UsableCredential): CredentialClientOption {
	return {
		name: credential.name,
		scope: credential.scope,
		kind: credential.kind,
		hosts: credential.hosts,
	}
}

/** `"work" (org), "work" (personal)`: names and scopes to pick from. */
function describeOptions(credentials: ReadonlyArray<UsableCredential>) {
	return credentials
		.map((credential) => `"${credential.name}" (${credential.scope})`)
		.join(', ')
}

function retryFor(key: string | null, credential: UsableCredential) {
	const pick = { name: credential.name, scope: credential.scope }
	return {
		...(key ? { credentials: { [key]: pick } } : {}),
		named: pick,
	}
}

export type RunCredentialEntries = {
	/** Entry package ids in precedence order. */
	packageIds: ReadonlyArray<string>
	/** For each pinned need key, the first entry whose closure declares it. */
	entryByKey: ReadonlyMap<string, string>
}

/**
 * The package whose stored mappings and creation link apply to `key`: the
 * calling package when it is an entry itself (or no entries are known),
 * else the first entry whose pinned closure has the key. Declared-use checks
 * and bound Keys still use the calling package.
 */
async function mappingPackageIdFor(ctx: CredentialClientContext, key: string) {
	if (!ctx.packageId) return null
	const entries = ctx.runEntries ? await ctx.runEntries() : null
	if (!entries || entries.packageIds.includes(ctx.packageId)) {
		return ctx.packageId
	}
	return entries.entryByKey.get(key) ?? ctx.packageId
}

async function loadNeed(ctx: CredentialClientContext, key: string) {
	if (ctx.runNeeds) return (await ctx.runNeeds()).get(key) ?? null
	if (!ctx.packageId) return null
	const needs = await loadPackageNeeds({
		env: ctx.env,
		orgId: requireActorRequest(ctx).org.id,
		packageId: ctx.packageId,
		request: requireActorRequest(ctx),
	})
	return needs.find((need) => need.key === key) ?? null
}

/** The creation link for an unbound need, naming its package when known. */
async function createUrlForNeed(
	ctx: CredentialClientContext,
	input: { key: string; provider: string; need: SavedCredentialNeed | null },
) {
	const packageId = await mappingPackageIdFor(ctx, input.key)
	const saved = packageId
		? await getSavedPackageById(ctx.env.APP_DB, {
				userId: requireActorRequest(ctx).org.id,
				packageId,
			}).catch(() => null)
		: null
	return buildNeedCreateUrl({
		db: ctx.env.APP_DB,
		baseUrl: ctx.callerContext.baseUrl,
		orgSlug: requireActorRequest(ctx).org.slug,
		key: input.key,
		provider: input.provider,
		need: input.need,
		packageKodyId: saved?.kodyId ?? null,
	})
}

/**
 * `credential.named` works only in ad hoc code and in a package of the
 * actor's personal org that is not listed in Community.
 */
async function assertNamedAllowed(ctx: CredentialClientContext) {
	if (!ctx.packageId) return
	const request = requireActorRequest(ctx)
	// Equal-id fixtures and stamped distinct signup orgs both count as personal.
	const personal =
		request.org.id ===
			personalOrgIdForPerson({
				userId: request.actor!.userId,
				personalOrgId: ctx.callerContext.user?.personalOrgId,
			}) || (await isPersonalOrg(ctx.env.APP_DB, request.org.id))
	const listed = personal
		? await ctx.env.APP_DB.prepare(
				`SELECT 1 AS listed FROM community_listings
				WHERE package_id = ? AND status = 'active' AND deleted_at IS NULL
				LIMIT 1`,
			)
				.bind(ctx.packageId)
				.first<{ listed: number }>()
		: null
	const limited =
		personal && !listed
			? await isPackageCredentialUseLimited({
					env: ctx.env,
					request,
					orgId: request.org.id,
					packageId: ctx.packageId,
				})
			: true
	if (limited) {
		throw refusal(
			'credential_denied',
			'credential.named works only in ad hoc execute and in unshared packages of your personal org. Declare the credential in kody.credentials and call credential(key) instead.',
		)
	}
}

function pickOne(input: {
	key: string | null
	candidates: Array<UsableCredential>
	possibleMatches: Array<UsableCredential>
	describe: string
	/** Set unless exactly one candidate matches: the error's creation link. */
	createUrl?: string
}) {
	const [only, second] = input.candidates
	if (only && !second) return only
	if (!only) {
		throw refusal(
			'credential_unbound',
			`No credential you can use matches ${input.describe}.${
				input.possibleMatches.length > 0
					? ' Some matching credentials have no provider; pick one by name, or set its provider with credentialUpdate so it resolves on its own.'
					: ''
			}`,
			{
				retryWith: input.possibleMatches.map((match) =>
					retryFor(input.key, match),
				),
				possibleMatches: input.possibleMatches.map(toOption),
				...(input.createUrl ? { createUrl: input.createUrl } : {}),
			},
		)
	}
	throw refusal(
		'credential_ambiguous',
		`More than one credential you can use matches ${input.describe}: ${describeOptions(input.candidates)}. Pick one by name and scope.`,
		{
			retryWith: input.candidates.map((candidate) =>
				retryFor(input.key, candidate),
			),
			options: input.candidates.map(toOption),
			...(input.createUrl ? { createUrl: input.createUrl } : {}),
		},
	)
}

/**
 * A package need's stored mapping (trigger override, then the actor's own
 * default, then the org default), or null to auto-resolve. Interactive runs
 * have no trigger override; a trigger run acts as its enabler.
 *
 * Concurrent opens share one mappings read via the microtask batcher
 * (KODY-AZ). Sequential opens on the same request reuse a request-scoped
 * unfiltered scope load (KODY-BF / queue consumers).
 */
async function resolveMappedNeed(
	ctx: CredentialClientContext,
	input: {
		request: RequestContext
		key: string
		target: NeedTarget
		usable: ReadonlyArray<UsableCredential>
		createUrl: () => Promise<string>
		supplier?: SavedCredentialNeed['supplier']
	},
): Promise<Array<UsableCredential> | null> {
	const packageId = await mappingPackageIdFor(ctx, input.key)
	if (!packageId) return null
	const enablementId = enablementIdOf(input.request)
	const rows = await loadCredentialMappings({
		db: ctx.env.APP_DB,
		orgId: input.request.org.id,
		packageId,
		personId: input.request.actor!.userId,
		enablementIds: enablementId ? [enablementId] : [],
		needKey: input.key,
		request: input.request,
	})
	const layer = (target: CredentialMappingRowTarget['target']) =>
		rows.find((row) => row.target.target === target)?.credentialIds ?? null
	const resolved = resolveStoredMapping({
		trigger: layer('enablement'),
		mine: layer('mine'),
		org: input.supplier === 'executor' ? null : layer('org'),
		usable: input.usable,
		accepts: (credential) => mappedCredentialFits(credential, input.target),
	})
	if (!resolved) return null
	const where =
		resolved.source === 'trigger'
			? 'this trigger'
			: resolved.source === 'mine'
				? 'your default'
				: 'the org default'
	switch (resolved.status) {
		case 'ready':
			return resolved.credentials
		case 'none':
			throw refusal(
				'credential_unbound',
				`Need "${input.key}" is mapped to no credential on purpose (${where}). Change that mapping in the package's credential settings, or create a credential and map it.`,
				{ createUrl: await input.createUrl() },
			)
		case 'unusable':
			throw refusal(
				'credential_not_found',
				`The credential mapped to need "${input.key}" for ${where} is gone or you can no longer use it. Map another credential to it in the package's trigger settings.`,
				{ createUrl: await input.createUrl() },
			)
		default: {
			const exhaustive: never = resolved
			throw new Error(`Unhandled mapping status: ${JSON.stringify(exhaustive)}`)
		}
	}
}

/** With a `link`, a name with no match carries a creation link. */
function findByName(
	usable: ReadonlyArray<UsableCredential>,
	pick: CredentialPick,
	key: string | null,
	link?: { baseUrl: string } & CredentialCreateLinkInput,
) {
	const matches = usable.filter(
		(credential) =>
			credential.name === pick.name &&
			(!pick.scope || credential.scope === pick.scope),
	)
	if (matches.length === 0) {
		throw refusal(
			'credential_not_found',
			`No credential named "${pick.name}" that you can use${pick.scope ? ` in ${pick.scope} scope` : ''}.`,
			link
				? {
						createUrl: buildCredentialCreateUrl(link.baseUrl, {
							...link,
							name: pick.name,
						}),
					}
				: {},
		)
	}
	// Package-bound Keys share scope `org` with user-scope Keys. Name picks
	// (call map / credential.named) keep the historical user-scope Key when
	// both exist; package Keys fill declared needs via auto-pick instead.
	const unbound = matches.filter((credential) => credential.packageId == null)
	const candidates = unbound.length > 0 ? unbound : matches
	return pickOne({
		key,
		candidates,
		possibleMatches: [],
		describe: `the name "${pick.name}"`,
	})
}

/**
 * An explicit call-map pick (resolution rule 2): the kind filter must match,
 * and the provider must match when both sides have one.
 */
function pickExplicit(input: {
	key: string
	pick: CredentialPick
	usable: ReadonlyArray<UsableCredential>
	target: NeedTarget
	baseUrl: string
	orgSlug: string | null
}): Picked {
	const { kind, provider, match } = input.target
	const credential = findByName(input.usable, input.pick, input.key, {
		baseUrl: input.baseUrl,
		orgSlug: input.orgSlug,
		...(match === 'exact' && kind
			? { kind, kindMode: 'required' as const }
			: {}),
	})
	if (match === 'exact' && kind && credential.kind !== kind) {
		throw refusal(
			'invalid_request',
			`credentials.${input.key} picks "${credential.name}", a ${credential.kind} credential; this need takes a ${kind} credential.`,
		)
	}
	if (
		match === 'fetch-capable' &&
		!isFetchCapableCredentialKind(credential.kind)
	) {
		throw refusal(
			'invalid_request',
			`credentials.${input.key} picks "${credential.name}", a ${credential.kind} credential; this need takes any fetch-capable credential (secret, oauth, or login).`,
		)
	}
	if (credential.provider && credential.provider !== provider) {
		throw refusal(
			'invalid_request',
			`credentials.${input.key} picks "${credential.name}", whose provider is "${credential.provider}"; this need takes provider "${provider}".`,
		)
	}
	return {
		credential,
		hint: credential.provider
			? null
			: `"${credential.name}" has no provider. Set its provider to "${provider}" with credentialUpdate so it resolves without a pick.`,
	}
}

/** The visitor's mapped credentials for an executor need, under their live grant. */
async function resolveExecutorNeedPicks(
	ctx: CredentialClientContext,
	key: string,
	need: NonNullable<Awaited<ReturnType<typeof loadNeed>>>,
	mode: 'one' | 'many',
): Promise<Array<Picked>> {
	const grant = await ctx.packageAppAuthority?.visitorNeedGrant(key)
	const visitorUsable = grant
		? liveUsableCredentials(
				await listUsableCredentials({
					env: ctx.env,
					request: grant.request,
					packageId: ctx.packageId,
				}),
			)
		: []
	const credentialIds = grant
		? await findPackageAppGrantCredentialMapping({
				db: ctx.env.APP_DB,
				grantId: grant.grantId,
				needKey: key,
			})
		: []
	const mapped = credentialIds
		.map((id) => visitorUsable.find((credential) => credential.id === id))
		.filter(
			(credential): credential is UsableCredential =>
				credential !== undefined &&
				mappedCredentialFits(credential, needTarget(key, need)),
		)
	if (mapped.length === 0) {
		throw refusal(
			'credential_unbound',
			`Credential need "${key}" is not connected. Sign in with Kody and allow need:${key} to choose credentials.`,
		)
	}
	return (mode === 'one' ? mapped.slice(0, 1) : mapped).map((credential) => ({
		credential,
		hint: null,
		packageAppRequest: grant!.request,
	}))
}

async function resolveKey(
	ctx: CredentialClientContext,
	key: string,
	usable: ReadonlyArray<UsableCredential>,
	mode: 'one' | 'many',
): Promise<Array<Picked>> {
	const runNeed = await loadNeed(ctx, key)
	// The run's needs can come from a sibling entry, so the calling package's
	// own closure decides; a key only it declares resolves as it declares it.
	const declared = ctx.packageId
		? await assertCredentialUsesDeclared({
				env: ctx.env,
				request: requireActorRequest(ctx),
				orgId: requireActorRequest(ctx).org.id,
				packageId: ctx.packageId,
				references: [{ use: 'key', key }],
			}).catch((error: unknown) => {
				throw toCredentialClientError(error) ?? error
			})
		: null
	const declaredNeed = declared?.get(key)
	const need =
		runNeed ??
		(declaredNeed ? (savedCredentialNeeds([declaredNeed])[0] ?? null) : null)
	const isVisitorNeedAuthority = Boolean(
		ctx.packageAppAuthority?.issue &&
		'visitorNeed' in ctx.packageAppAuthority.issue,
	)
	const withPackageAppIssue = (picked: Array<Picked>) =>
		isVisitorNeedAuthority
			? picked.map((item) => ({
					...item,
					packageAppIssue:
						need?.supplier === 'executor'
							? ({ executorNeed: key } as const)
							: ({ visitorNeed: key } as const),
				}))
			: picked
	// An app's runs-as person is not the executor; each visitor picks theirs.
	if (
		ctx.packageAppAuthority?.issue &&
		'runsAs' in ctx.packageAppAuthority.issue &&
		need?.supplier === 'executor'
	) {
		throw refusal(
			'credential_denied',
			`Credential need "${key}" is supplied by each app visitor; use credential.visitor("${key}")`,
		)
	}
	if (
		ctx.packageAppAuthority?.issue &&
		'visitorNeed' in ctx.packageAppAuthority.issue &&
		need?.supplier === 'publisher'
	) {
		throw refusal(
			'credential_denied',
			`Credential need "${key}" is supplied by the publisher; use credential("${key}")`,
		)
	}
	if (isVisitorNeedAuthority && need?.supplier === 'executor') {
		return withPackageAppIssue(
			await resolveExecutorNeedPicks(ctx, key, need, mode),
		)
	}
	const target = needTarget(key, need)
	const picks = ctx.callMap?.get(key)
	if (!picks) {
		// Mappings belong to declared needs; a row left by a removed need is ignored.
		const mapped = need
			? await resolveMappedNeed(ctx, {
					request: requireActorRequest(ctx),
					key,
					target,
					usable,
					createUrl: () =>
						createUrlForNeed(ctx, { key, provider: target.provider, need }),
					supplier: need?.supplier,
				})
			: null
		if (mapped) {
			return withPackageAppIssue(
				(mode === 'one' ? mapped.slice(0, 1) : mapped).map((credential) => ({
					credential,
					hint: null,
				})),
			)
		}
		const resolution = need
			? resolveNeedCandidates(
					need,
					need.supplier === 'publisher'
						? usable.filter((credential) => credential.scope === 'org')
						: usable,
				)
			: {
					autoPick: null as UsableCredential | null,
					candidates: usable.filter(
						(candidate) => candidate.provider === target.provider,
					),
					possibleMatches: [] as Array<UsableCredential>,
				}
		if (resolution.autoPick) {
			return withPackageAppIssue([
				{ credential: resolution.autoPick, hint: null },
			])
		}
		const createUrl = await createUrlForNeed(ctx, {
			key,
			provider: target.provider,
			need,
		})
		const credential = pickOne({
			key,
			candidates: resolution.candidates,
			possibleMatches: resolution.possibleMatches,
			describe: target.describe,
			createUrl,
		})
		return withPackageAppIssue([{ credential, hint: null }])
	}
	if (mode === 'one' && picks.length === 0) {
		throw refusal(
			'credential_unbound',
			`The credentials map picks no credential for "${key}".`,
			{
				createUrl: await createUrlForNeed(ctx, {
					key,
					provider: target.provider,
					need,
				}),
			},
		)
	}
	const picked = new Map<string, Picked>()
	for (const pick of picks) {
		const one = pickExplicit({
			key,
			pick,
			usable,
			target,
			baseUrl: ctx.callerContext.baseUrl,
			orgSlug: requireActorRequest(ctx).org.slug,
		})
		picked.set(one.credential.id, one)
	}
	const all = [...picked.values()].map((one) => one.credential)
	if (mode === 'one' && all.length > 1) {
		throw refusal(
			'invalid_request',
			`The credentials map picks ${all.length} credentials for "${key}": ${describeOptions(all)}. Pick one of them for credential("${key}"), or call credentials("${key}") to get all of them.`,
			{
				retryWith: all.map((credential) => retryFor(key, credential)),
				options: all.map(toOption),
			},
		)
	}
	return withPackageAppIssue([...picked.values()])
}

async function issueClient(
	ctx: CredentialClientContext,
	key: string | null,
	{ credential: picked, hint, packageAppRequest }: Picked,
	options: {
		packageAppIssue?: PackageAppCredentialHandleIssue | null
	} = {},
): Promise<OpenedCredentialClient> {
	if (!ctx.binding.trim()) {
		throw refusal(
			'invalid_request',
			'credential() cannot open a client here: this call has no request-scoped credential client binding, so the client could never be used. Call credential() while handling a request or run.',
		)
	}
	const request = packageAppRequest ?? requireActorRequest(ctx)
	if (picked.kind === 'mcp' && picked.scope === 'personal') {
		throw refusal(
			'credential_denied',
			'A personal MCP server cannot be used through credential() yet. Connect it in the org instead.',
		)
	}
	const handle = await signCredentialClientHandle({
		env: ctx.env,
		handle: {
			id: picked.id,
			kind: picked.kind,
			name: picked.name,
			scope: picked.scope,
			org: request.org.id,
			actor: request.actor!.userId,
			binding: ctx.binding,
			...('packageAppIssue' in options
				? (options.packageAppIssue ?? {})
				: (ctx.packageAppAuthority?.issue ?? {})),
		},
	})
	return {
		handle,
		key,
		name: picked.name,
		scope: picked.scope,
		kind: picked.kind,
		hosts: picked.hosts,
		...(hint ? { hint } : {}),
	}
}

export async function openCredentialClient(
	ctx: CredentialClientContext,
	input: { key?: unknown; name?: unknown; scope?: unknown },
): Promise<OpenedCredentialClient> {
	if (input.name != null) {
		const request = requireActorRequest(ctx)
		const usable = liveUsableCredentials(
			await listUsableCredentials({
				env: ctx.env,
				request,
				packageId: ctx.packageId,
			}),
		)
		await assertNamedAllowed(ctx)
		const pick = {
			name: readText(input.name, 'A credential name'),
			scope: readScope(input.scope),
		}
		return await issueClient(ctx, null, {
			credential: findByName(usable, pick, null, {
				baseUrl: ctx.callerContext.baseUrl,
				orgSlug: request.org.slug,
			}),
			hint: null,
		})
	}
	const key = readText(input.key, 'A credential key')
	// A visitor from outside the app's org has no acting request there; only
	// their own executor credentials, under their live grant, can open.
	if (
		!ctx.callerContext.request?.actor &&
		ctx.packageAppAuthority?.issue &&
		'visitorNeed' in ctx.packageAppAuthority.issue
	) {
		const need = await loadNeed(ctx, key)
		if (need?.supplier === 'executor') {
			const orgId = ctx.packageAppAuthority.orgId
			if (!orgId) requireActorRequest(ctx)
			// The run's needs are the entry app's; the opening package itself
			// must declare the key too.
			await assertCredentialUsesDeclared({
				env: ctx.env,
				request: null,
				orgId: orgId!,
				packageId: ctx.packageId,
				references: [{ use: 'key', key }],
			}).catch((error: unknown) => {
				throw toCredentialClientError(error) ?? error
			})
			const [picked] = await resolveExecutorNeedPicks(ctx, key, need, 'one')
			return await issueClient(ctx, key, picked!, {
				packageAppIssue: { executorNeed: key },
			})
		}
	}
	const usable = liveUsableCredentials(
		await listUsableCredentials({
			env: ctx.env,
			request: requireActorRequest(ctx),
			packageId: ctx.packageId,
		}),
	)
	const picked = await resolveKey(ctx, key, usable, 'one')
	return await issueClient(
		ctx,
		key,
		picked[0]!,
		'packageAppIssue' in picked[0]!
			? { packageAppIssue: picked[0]!.packageAppIssue }
			: {},
	)
}

/**
 * `credentials(key)`: every pick the call map gives for the key, or the one
 * candidate when it gives none (a `multiple` need never gets "all of them").
 */
export async function openCredentialClients(
	ctx: CredentialClientContext,
	input: { key?: unknown },
): Promise<Array<OpenedCredentialClient>> {
	const key = readText(input.key, 'A credential key')
	const usable = liveUsableCredentials(
		await listUsableCredentials({
			env: ctx.env,
			request: requireActorRequest(ctx),
			packageId: ctx.packageId,
		}),
	)
	const picked = await resolveKey(ctx, key, usable, 'many')
	return await Promise.all(
		picked.map((one) =>
			issueClient(
				ctx,
				key,
				one,
				'packageAppIssue' in one
					? { packageAppIssue: one.packageAppIssue }
					: {},
			),
		),
	)
}

/**
 * Every need the run's entry packages declare, by key, first entry wins.
 * Pass entries only (see `credentialNeedsEntryPackageIds`): an entry's
 * closure pins its static dependencies' needs, so a dependency's later
 * publish never adds or replaces them.
 */
export async function loadRunCredentialNeeds(input: {
	env: Env
	/** The run's org; needs load without an acting person. */
	orgId: string
	packageIds: ReadonlyArray<string>
	request?: RequestContext | null
}): Promise<ReadonlyMap<string, SavedCredentialNeed>> {
	const { needs } = await loadRunCredentialNeedEntries(input)
	return needs
}

/**
 * `loadRunCredentialNeeds` plus, per key, the entry that pinned it (the same
 * first-entry-wins rule), for mapping selection.
 */
export async function loadRunCredentialNeedEntries(input: {
	env: Env
	orgId: string
	packageIds: ReadonlyArray<string>
	request?: RequestContext | null
}): Promise<{
	needs: ReadonlyMap<string, SavedCredentialNeed>
	entries: RunCredentialEntries
}> {
	const needLists = await Promise.all(
		input.packageIds.map((packageId) =>
			loadPackageNeeds({
				env: input.env,
				orgId: input.orgId,
				packageId,
				request: input.request,
			}),
		),
	)
	const needs = new Map<string, SavedCredentialNeed>()
	const entryByKey = new Map<string, string>()
	needLists.forEach((list, index) => {
		for (const need of list) {
			if (needs.has(need.key)) continue
			needs.set(need.key, need)
			entryByKey.set(need.key, input.packageIds[index]!)
		}
	})
	return { needs, entries: { packageIds: [...input.packageIds], entryByKey } }
}

/**
 * Validates a call map before code runs (resolution rule 4). Every pick must
 * resolve. A key no package in the run declares is an error when `strict`
 * (an invoke) and a warning otherwise (ad hoc code reads it as a provider).
 */
export async function validateCredentialCallMap(input: {
	env: Env
	request: RequestContext | null
	map: CredentialCallMap
	packageIds: ReadonlyArray<string>
	strict: boolean
	/** Origin for creation links on a pick with no match. */
	baseUrl: string
}): Promise<{ warnings: Array<string> }> {
	return await withClientErrors(input, async () => {
		const request = input.request
		if (!request?.actor) {
			throw refusal(
				'credential_denied',
				'A credentials map needs a person. This run has no acting person.',
			)
		}
		const entryPackageIds = input.packageIds
		const [baseUsable, needLists, boundLists] = await Promise.all([
			listUsableCredentials({
				env: input.env,
				request,
				packageId: null,
			}).then(liveUsableCredentials),
			Promise.all(
				entryPackageIds.map(async (packageId) => ({
					packageId,
					needs: await loadPackageNeeds({
						env: input.env,
						orgId: request.org.id,
						packageId,
						request,
					}),
				})),
			),
			Promise.all(
				entryPackageIds.map(async (packageId) => ({
					packageId,
					bound: liveUsableCredentials(
						await listUsableCredentials({
							env: input.env,
							request,
							packageId,
						}),
					).filter((credential) => credential.packageId === packageId),
				})),
			),
		])
		const needs = new Map<string, SavedCredentialNeed>()
		const needDeclaredBy = new Map<string, Array<string>>()
		for (const { packageId, needs: list } of needLists) {
			for (const need of list) {
				if (!needs.has(need.key)) needs.set(need.key, need)
				const owners = needDeclaredBy.get(need.key) ?? []
				owners.push(packageId)
				needDeclaredBy.set(need.key, owners)
			}
		}
		const boundByPackage = new Map(
			boundLists.map(({ packageId, bound }) => [packageId, bound]),
		)
		const warnings: Array<string> = []
		for (const [key, picks] of input.map) {
			const need = needs.get(key) ?? null
			if (need?.supplier === 'publisher') {
				throw refusal(
					'invalid_request',
					`Credential need "${need.key}" is supplied by the publisher. Only the org-level mapping can set it.`,
				)
			}
			if (!need) {
				const declared = [...needs.keys()]
				const message = `credentials.${key} is not a need ${
					entryPackageIds.length > 0
						? 'any package in this run declares'
						: 'of this code'
				}${declared.length > 0 ? ` (declared: ${declared.join(', ')})` : ''}.`
				if (input.strict) {
					throw refusal('credential_need_unknown', message)
				}
				warnings.push(
					`${message} It applies only to credential("${key}") calls, which read "${key}" as a provider.`,
				)
			}
			const target = needTarget(key, need)
			// Keep package-bound Keys inside the declaring package's pool so a
			// multi-entry run cannot pick package A's Key for package B's need.
			const owners = needDeclaredBy.get(key) ?? []
			const pools =
				owners.length > 0
					? owners.map((packageId) => [
							...baseUsable,
							...(boundByPackage.get(packageId) ?? []),
						])
					: [baseUsable]
			for (const pick of picks) {
				let lastError: unknown
				let ok = false
				for (const usable of pools) {
					try {
						pickExplicit({
							key,
							pick,
							usable,
							target,
							baseUrl: input.baseUrl,
							orgSlug: request.org.slug,
						})
						ok = true
						break
					} catch (error) {
						lastError = error
					}
				}
				if (!ok) throw lastError
			}
		}
		return { warnings }
	})
}

type HandleContext = Pick<
	CredentialClientContext,
	'env' | 'callerContext' | 'binding' | 'packageAppAuthority'
>

/** A verified handle and who the door resolves it as. */
type HandleUse = {
	handle: CredentialClientHandle
	/** The viewer, or the app's credential authority for a visitor handle. */
	request: RequestContext
	auditDetails?: Record<string, string | null>
}

/**
 * A stamped handle resolves as the live runs-as person or consented
 * visitor. Each use re-checks live consent, and executor handles also
 * re-check the credential mapping on that grant. `ownerCredentialForVisitors`
 * on a handle is ignored.
 */
async function readHandle(
	ctx: HandleContext,
	token: unknown,
	kinds: ReadonlyArray<PackageCredentialKind>,
	operation: string,
): Promise<HandleUse> {
	let appRequest: RequestContext | null = null
	const handle = await verifyCredentialClientHandle({
		env: ctx.env,
		token: typeof token === 'string' ? token : '',
		request: ctx.callerContext.request,
		binding: ctx.binding,
		runsAsRequest: async () => {
			const request = (await ctx.packageAppAuthority?.runsAsRequest()) ?? null
			appRequest = request
			return request
		},
		visitorNeedRequest: async (needKey) => {
			const request =
				(await ctx.packageAppAuthority?.visitorNeedRequest(needKey)) ?? null
			appRequest = request
			return request
		},
		visitorNeedGrant: async (needKey) => {
			const grant =
				(await ctx.packageAppAuthority?.visitorNeedGrant(needKey)) ?? null
			appRequest = grant?.request ?? null
			return grant
		},
	})
	if (!kinds.includes(handle.kind)) {
		throw refusal(
			'invalid_request',
			`A ${handle.kind} credential has no ${operation}.`,
		)
	}
	if (handle.executorNeed) {
		const grant =
			(await ctx.packageAppAuthority?.visitorNeedGrant(handle.executorNeed)) ??
			null
		const credentialIds = grant
			? await findPackageAppGrantCredentialMapping({
					db: ctx.env.APP_DB,
					grantId: grant.grantId,
					needKey: handle.executorNeed,
				})
			: []
		if (!credentialIds.includes(handle.id)) {
			throw refusal(
				'credential_unbound',
				`Credential need "${handle.executorNeed}" is not connected. Sign in with Kody and allow need:${handle.executorNeed} to choose credentials.`,
			)
		}
	}
	if (
		(handle.runsAs || handle.visitorNeed || handle.executorNeed) &&
		appRequest
	) {
		return { handle, request: appRequest }
	}
	return { handle, request: ctx.callerContext.request! }
}

function doorInput<T extends CredentialTarget>(
	ctx: Pick<CredentialClientContext, 'env' | 'callerContext' | 'packageId'>,
	use: HandleUse,
	credential: T,
): ResolveCredentialInput<T> {
	return {
		env: ctx.env,
		orgId: use.request.org.id,
		actor: use.request,
		packageStamp: null,
		runPackageId: ctx.packageId,
		baseUrl: ctx.callerContext.baseUrl,
		...(use.auditDetails ? { auditDetails: use.auditDetails } : {}),
		credential,
	}
}

async function withClientErrors<T>(
	link: {
		baseUrl: string | undefined
		request: RequestContext | null | undefined
	},
	run: () => Promise<T>,
) {
	try {
		return await run()
	} catch (error) {
		throw (
			toCredentialClientError(error, {
				baseUrl: link.baseUrl,
				orgSlug: link.request?.org.slug,
			}) ?? error
		)
	}
}

export async function signWithCredentialClient(
	ctx: CredentialClientContext,
	input: { handle?: unknown; host?: unknown; operation?: unknown },
) {
	return await withClientErrors(ctx.callerContext, async () => {
		const host = readText(input.host, 'sign() host')
		const operation = input.operation as SigningOperation | undefined
		if (
			!operation ||
			typeof operation !== 'object' ||
			(operation.type !== 'jwt' && operation.type !== 'hmac')
		) {
			throw refusal(
				'invalid_request',
				'sign() takes { type: "jwt", ... } or { type: "hmac", ... }.',
			)
		}
		// HMAC may use a Key (`secret`) or a signing credential. JWT signing
		// still requires kind "signing" (key material that never leaves).
		const allowedKinds =
			operation.type === 'hmac'
				? (['signing', 'secret'] as const)
				: (['signing'] as const)
		const use = await readHandle(ctx, input.handle, allowedKinds, 'sign()')
		return await resolveCredential(
			doorInput(ctx, use, {
				use: 'signing',
				credentialId: use.handle.id,
				requestHost: host,
				operation,
			}),
		)
	})
}

export async function callToolWithCredentialClient(
	ctx: CredentialClientContext,
	input: { handle?: unknown; tool?: unknown; args?: unknown },
): Promise<CallToolResult> {
	return await withClientErrors(ctx.callerContext, async () => {
		const use = await readHandle(ctx, input.handle, ['mcp'], 'callTool()')
		const { handle } = use
		const toolName = readText(input.tool, 'callTool() tool name')
		const args =
			input.args && typeof input.args === 'object' && !Array.isArray(input.args)
				? (input.args as Record<string, unknown>)
				: {}
		const server = await findCredentialById({
			db: ctx.env.APP_DB,
			ownerId: use.request.org.id,
			id: handle.id,
			scope: 'org',
		})
		const connection = await resolveCredential(
			doorInput(ctx, use, {
				use: 'mcp-connection',
				serverId: handle.id,
				serverName: server?.name ?? handle.name,
				waitUntil: ctx.waitUntil,
			}),
		)
		return await connection.callTool({ toolName, args })
	})
}

export async function refreshCredentialClient(
	ctx: CredentialClientContext,
	input: { handle?: unknown },
) {
	return await withClientErrors(ctx.callerContext, async () => {
		const use = await readHandle(ctx, input.handle, ['oauth'], 'refresh')
		return await resolveCredential(
			doorInput(ctx, use, {
				use: 'client-oauth-refresh',
				credentialId: use.handle.id,
				userEmail: ctx.callerContext.user?.email,
				waitUntil: ctx.waitUntil,
			}),
		)
	})
}

/** Where a client fetch's credential goes: a header, a query param, or a whole URL. */
export type CredentialClientPlacement =
	| { kind: 'header'; name: string; value: string }
	| { kind: 'query'; param: string; value: string }
	| { kind: 'url'; url: URL }

export type AppliedCredentialClient = {
	placement: CredentialClientPlacement
	substitutedValues: ReadonlyArray<string>
	/** The inject shape with no value, for a 401 / 403 hint. */
	shape: string
	/** A login credential's session id (never the session), for a 401 retry. */
	login?: { sessionId: string | null }
}

function fromResolved(
	placed: ResolvedClientPlacement,
): AppliedCredentialClient {
	return {
		placement: placed.placement,
		substitutedValues: placed.substitutedValues,
		shape: placed.shape,
	}
}

/**
 * The gateway's half of a client fetch: verify the handle, then resolve where
 * the credential goes on this request through the door. A header or query
 * placement replaces one of that name the code set; a `url` credential
 * replaces the request's origin and base path with its own URL.
 */
export async function applyCredentialClient(input: {
	env: Env
	request: RequestContext | null
	baseUrl: string
	/** The run's package; only the self-publish guard reads it here. */
	packageId: string | null
	binding: string | null | undefined
	/** See `CredentialClientContext.packageAppAuthority`. */
	packageAppAuthority?: PackageAppCredentialAuthority | null
	token: string
	requestUrl: URL
	/** A login session a host answered 401 to; the door drops it and re-mints. */
	rejectedLoginSessionId?: string | null
}): Promise<AppliedCredentialClient> {
	return await withClientErrors(input, async () => {
		const ctx = {
			env: input.env,
			packageId: input.packageId,
			binding: input.binding ?? '',
			packageAppAuthority: input.packageAppAuthority ?? null,
			callerContext: {
				baseUrl: input.baseUrl,
				request: input.request,
			} as McpCallerContext,
		}
		const use = await readHandle(
			ctx,
			input.token,
			packageCredentialKindValues,
			'fetch',
		)
		const { handle } = use
		const { requestUrl } = input
		switch (handle.kind) {
			case 'secret':
				return fromResolved(
					await resolveCredential(
						doorInput(ctx, use, {
							use: 'client-key',
							credentialId: handle.id,
							requestUrl,
						}),
					),
				)
			case 'oauth':
				return fromResolved(
					await resolveCredential(
						doorInput(ctx, use, {
							use: 'client-oauth',
							credentialId: handle.id,
							requestUrl,
						}),
					),
				)
			case 'url': {
				const resolved = await resolveCredential(
					doorInput(ctx, use, {
						use: 'url',
						credentialId: handle.id,
						path: `${requestUrl.pathname}${requestUrl.search}`,
					}),
				)
				return {
					placement: { kind: 'url', url: resolved.url },
					substitutedValues: resolved.substitutedValues,
					shape: 'url',
				}
			}
			case 'login': {
				const session = await resolveCredential(
					doorInput(ctx, use, {
						use: 'login',
						credentialId: handle.id,
						requestUrl,
						rejectedSessionId: input.rejectedLoginSessionId ?? null,
					}),
				)
				const { placement } = session
				return {
					placement,
					substitutedValues: session.substitutedValues,
					login: { sessionId: session.sessionId },
					shape:
						placement.kind === 'header'
							? `login session in header ${placement.name}`
							: `login session in query ${placement.param}`,
				}
			}
			case 'mcp':
			case 'signing':
				throw refusal(
					'invalid_request',
					`A ${handle.kind} credential has no fetch; use ${handle.kind === 'mcp' ? 'callTool()' : 'sign()'}.`,
				)
			default: {
				const exhaustive: never = handle.kind
				throw new Error(`Unhandled credential kind: ${String(exhaustive)}`)
			}
		}
	})
}
