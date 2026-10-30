import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { isRecord } from '@kody-internal/shared/is-record.ts'
import { isOrgPermission } from '@kody-internal/shared/org-permissions.ts'
import {
	personIdFromStored,
	ownerIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	type AutomationSource,
	type OrgRole,
	type RequestActor,
	type RequestAttribution,
	type RequestContext,
	type RequestCredential,
	type RequestCredentialKind,
	type RequestLineage,
	type RequestOrg,
} from '@kody-internal/shared/request-context.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'

/**
 * Who a verified inbound email runs as (`classifyInboundEmailSender`).
 * Unverified mail never reaches a request source: it runs nothing.
 *
 * - `member`: the sender is a verified account email of a current member of
 *   the inbox's org, and the message authenticated. The member is the actor,
 *   with their own role.
 * - `inbox-owner`: an authenticated non-member (receipts, notifications).
 *   Which enablements run is a per-sender rule, not an inbox-owner fallback.
 */
export type InboundEmailSender =
	| { kind: 'member'; actor: RequestActor; role: OrgRole }
	| { kind: 'inbox-owner' }

/**
 * A triggered run of one enablement (credentials plan v4, section 3.3). The
 * run acts as the enabler with the role they hold right now, and is billed
 * and audited to them. The enablement id is the run's credential id.
 */
export type EnablementRun = {
	id: string
	enabler: RequestPerson
	role: OrgRole | null
}

/**
 * How a request reached Kody. Every place that builds a caller context names
 * its source, and `deriveRequestContext` turns it into the one shape
 * `authorize` reads. A trigger source without `enablement` only names where
 * an event came from: its request has no person and holds no permissions.
 * Every triggered run carries the enablement it runs as.
 */
export type RequestSource =
	| { kind: 'session' }
	| { kind: 'mcp-oauth' }
	| { kind: 'cli' }
	| { kind: 'api-token'; tokenId: string }
	| { kind: 'package-app' }
	/** A run on a registered execution context, acting as its requester. */
	| { kind: 'execution-context-run'; ecid: string; runId: string }
	| { kind: 'schedule'; jobId: string; enablement?: EnablementRun }
	| { kind: 'webhook'; sourceId: string; enablement?: EnablementRun }
	| {
			kind: 'inbound-email'
			sourceId: string
			sender: InboundEmailSender
			enablement?: EnablementRun
	  }
	| { kind: 'platform-event'; sourceId: string; enablement?: EnablementRun }
	/** Nested invokes, workflow steps, package events, sealed providers. */
	| { kind: 'inherited'; lineage: RequestLineage }

/**
 * The identity fields a request context is derived from. Prefer a stamped
 * `personalOrgId` (from `users.personal_org_id`) so phase-2 signups with
 * `orgs.id !== stable_user_id` bind correctly when `orgBinding` is omitted.
 */
type RequestPerson = Pick<
	McpUserContext,
	'userId' | 'username' | 'personalOrgId'
>

export type RequestOrgBinding = {
	org: RequestOrg
	/** Null for grant-only outside collaborators. */
	role: OrgRole | null
}

/**
 * Which org a person acts in, and with which role. Prefer a stamped
 * `personalOrgId`; fall back to the identity cast for callers that have not
 * loaded `users.personal_org_id` yet. DB-backed paths pass `orgBinding`
 * from membership instead.
 */
function resolveOrgBinding(user: RequestPerson): RequestOrgBinding {
	return {
		org: {
			id: personalOrgIdForPerson(user),
			slug: user.username?.trim() || null,
		},
		role: 'owner',
	}
}

function actorFor(user: RequestPerson): RequestActor {
	return { userId: user.userId, username: user.username?.trim() || null }
}

function credentialFor(input: {
	kind: RequestCredentialKind
	id: string | null
	org: RequestOrg
	profileName: string | null
	scopes?: RequestCredential['scopes']
	contextCredentialIds?: RequestCredential['contextCredentialIds']
}): RequestCredential {
	return {
		kind: input.kind,
		id: input.id,
		orgId: input.org.id,
		scopes: input.scopes ?? null,
		profileName: input.profileName,
		...(input.contextCredentialIds
			? { contextCredentialIds: input.contextCredentialIds }
			: {}),
	}
}

function automation(input: {
	binding: RequestOrgBinding
	source: AutomationSource
	sourceId: string
	credentialKind: RequestCredentialKind
	profileName: string | null
	enablement: EnablementRun | undefined
}): RequestContext {
	const { enablement } = input
	if (enablement) {
		const actor = actorFor(enablement.enabler)
		return {
			org: input.binding.org,
			actor,
			attribution: { kind: 'user', userId: actor.userId },
			credential: credentialFor({
				kind: input.credentialKind,
				id: enablement.id,
				org: input.binding.org,
				profileName: null,
			}),
			membership: enablement.role ? { role: enablement.role } : null,
		}
	}
	return {
		org: input.binding.org,
		actor: null,
		attribution: {
			kind: 'automation',
			source: input.source,
			sourceId: input.sourceId,
		},
		credential: credentialFor({
			kind: input.credentialKind,
			id: input.sourceId,
			org: input.binding.org,
			profileName: input.profileName,
		}),
		membership: null,
	}
}

function credentialIdFor(
	source: Extract<
		RequestSource,
		{
			kind:
				| 'session'
				| 'mcp-oauth'
				| 'cli'
				| 'api-token'
				| 'package-app'
				| 'execution-context-run'
		}
	>,
	oauthClientId: string | null | undefined,
): string | null {
	switch (source.kind) {
		case 'api-token':
			return source.tokenId
		case 'execution-context-run':
			return source.runId
		case 'mcp-oauth':
		case 'cli':
			return oauthClientId?.trim() || null
		case 'session':
		case 'package-app':
			return null
		default: {
			const exhaustive: never = source
			throw new Error(`Unhandled credential source: ${String(exhaustive)}`)
		}
	}
}

/**
 * Build the request context for `user` reached through `source`.
 * `user` is the identity the caller context carries: the signed-in person
 * for interactive sources, and the org's owning account for triggers (the
 * enablement, not `user`, decides who a trigger acts as).
 */
export function deriveRequestContext(input: {
	user: RequestPerson
	source: RequestSource
	profileName?: string | null
	/** OAuth client of an `mcp-oauth` / `cli` bearer grant; the credential id. */
	oauthClientId?: string | null
	/** When set (DB-backed session paths), overrides {@link resolveOrgBinding}. */
	orgBinding?: RequestOrgBinding
	/** Credential scopes. Populated for API tokens; null does not narrow. */
	scopes?: RequestCredential['scopes']
	/** Execution-context runs: credential ids the context's grant allows. */
	contextCredentialIds?: RequestCredential['contextCredentialIds']
}): RequestContext {
	const binding = input.orgBinding ?? resolveOrgBinding(input.user)
	const { source } = input
	const profileName = input.profileName?.trim() || null
	switch (source.kind) {
		case 'session':
		case 'mcp-oauth':
		case 'cli':
		case 'api-token':
		case 'package-app':
		case 'execution-context-run': {
			const actor = actorFor(input.user)
			return {
				org: binding.org,
				actor,
				attribution: { kind: 'user', userId: actor.userId },
				credential: credentialFor({
					kind: source.kind,
					id: credentialIdFor(source, input.oauthClientId),
					org: binding.org,
					profileName,
					scopes: input.scopes ?? null,
					contextCredentialIds:
						source.kind === 'execution-context-run'
							? input.contextCredentialIds
							: null,
				}),
				membership: binding.role ? { role: binding.role } : null,
			}
		}
		case 'schedule':
			return automation({
				binding,
				source: 'schedule',
				sourceId: source.jobId,
				credentialKind: 'schedule',
				profileName,
				enablement: source.enablement,
			})
		case 'webhook':
			return automation({
				binding,
				source: 'webhook',
				sourceId: source.sourceId,
				credentialKind: 'webhook',
				profileName,
				enablement: source.enablement,
			})
		case 'inbound-email': {
			const request = automation({
				binding,
				source: 'email',
				sourceId: source.sourceId,
				credentialKind: 'inbound-email',
				profileName,
				enablement: source.enablement,
			})
			const { sender } = source
			if (source.enablement) return request
			switch (sender.kind) {
				case 'inbox-owner':
					return request
				case 'member':
					// Only decides which packages the sender may start; the runs
					// themselves carry the sender's enablement.
					return {
						...request,
						actor: sender.actor,
						membership: { role: sender.role },
					}
				default: {
					const exhaustive: never = sender
					throw new Error(
						`Unhandled inbound email sender: ${String(exhaustive)}`,
					)
				}
			}
		}
		case 'platform-event':
			return automation({
				binding,
				source: 'event',
				sourceId: source.sourceId,
				credentialKind: 'platform-event',
				profileName,
				enablement: source.enablement,
			})
		case 'inherited': {
			const { lineage } = source
			return {
				org: binding.org,
				actor: lineage.actor,
				attribution: lineage.attribution,
				credential: {
					...lineage.credential,
					profileName: lineage.credential.profileName ?? profileName,
				},
				membership: inheritedMembership(lineage, binding),
			}
		}
		default: {
			const exhaustive: never = source
			throw new Error(`Unhandled request source: ${String(exhaustive)}`)
		}
	}
}

/**
 * The starter's role carries over only within the org it was held in. Legacy
 * lineage without `membership` keeps the run identity's role only when the
 * starter is that identity (a personal org's owner); anyone else gets no role.
 */
function inheritedMembership(
	lineage: RequestLineage,
	binding: RequestOrgBinding,
): RequestContext['membership'] {
	if (!lineage.actor) return null
	if (lineage.membership === undefined) {
		// Legacy equal-id personal orgs only: actor.userId === org.id.
		// Distinct personal orgs always persist membership on lineage
		// (requestLineage); do not infer Owner from credential.orgId alone
		// (that would promote team Members).
		const personalOwner =
			String(lineage.actor.userId) === String(binding.org.id)
		return personalOwner && binding.role ? { role: binding.role } : null
	}
	if (String(lineage.credential.orgId) !== String(binding.org.id)) return null
	return lineage.membership
}

/** What a downstream run started by `request` inherits from it. */
export function requestLineage(request: RequestContext): RequestLineage {
	return {
		actor: request.actor,
		attribution: request.attribution,
		credential: request.credential,
		membership: request.membership,
	}
}

export function inheritRequest(request: RequestContext): RequestSource {
	return { kind: 'inherited', lineage: requestLineage(request) }
}

const triggerCredentialKinds: ReadonlySet<RequestCredentialKind> = new Set([
	'schedule',
	'webhook',
	'inbound-email',
	'platform-event',
])

/**
 * The enablement id when `request` is an enablement run, or a run nested in
 * one (lineage keeps the trigger credential and the enabler). A trigger
 * source with no enablement has no person, and interactive requests carry a
 * person's own credential, so neither matches.
 */
export function enablementIdOf(
	request: RequestContext | null | undefined,
): string | null {
	if (!request?.actor || request.attribution.kind !== 'user') return null
	if (!triggerCredentialKinds.has(request.credential.kind)) return null
	return request.credential.id
}

/**
 * The person a background run bills: an enablement's enabler, or the starter
 * of an inherited run. Null for a trigger source with no enablement, which
 * runs nothing.
 * Interactive sources bill their caller elsewhere.
 */
export function backgroundRunBilledActor(
	source: RequestSource,
): RequestActor | null {
	switch (source.kind) {
		case 'schedule':
		case 'webhook':
		case 'inbound-email':
		case 'platform-event':
			return source.enablement ? actorFor(source.enablement.enabler) : null
		case 'inherited':
			return source.lineage.actor
		case 'session':
		case 'mcp-oauth':
		case 'cli':
		case 'api-token':
		case 'package-app':
		case 'execution-context-run':
			return null
		default: {
			const exhaustive: never = source
			throw new Error(`Unhandled request source: ${String(exhaustive)}`)
		}
	}
}

const credentialKinds: ReadonlySet<string> = new Set<RequestCredentialKind>([
	'session',
	'mcp-oauth',
	'api-token',
	'cli',
	'package-app',
	'inbound-email',
	'webhook',
	'schedule',
	'platform-event',
])

const automationSources: ReadonlySet<string> = new Set<AutomationSource>([
	'webhook',
	'schedule',
	'email',
	'event',
])

function readNullableString(value: unknown) {
	return typeof value === 'string' && value.trim() ? value : null
}

function parseAttribution(value: unknown): RequestAttribution | null {
	if (!isRecord(value)) return null
	if (value.kind === 'user' && typeof value.userId === 'string') {
		return { kind: 'user', userId: personIdFromStored(value.userId) }
	}
	if (
		value.kind === 'automation' &&
		typeof value.source === 'string' &&
		automationSources.has(value.source) &&
		typeof value.sourceId === 'string'
	) {
		return {
			kind: 'automation',
			source: value.source as AutomationSource,
			sourceId: value.sourceId,
		}
	}
	return null
}

const orgRoles: ReadonlySet<string> = new Set<OrgRole>([
	'owner',
	'member',
	'billing',
])

/** `undefined` means malformed; `null` is a valid "no membership". */
function parseMembership(
	value: unknown,
): RequestContext['membership'] | undefined {
	if (value === null) return null
	if (
		isRecord(value) &&
		typeof value.role === 'string' &&
		orgRoles.has(value.role)
	) {
		return { role: value.role as OrgRole }
	}
	return undefined
}

/**
 * Read a lineage persisted across a durable boundary (workflow payloads,
 * queue messages). Returns null for anything malformed; the caller fails
 * closed.
 */
export function parseRequestLineage(value: unknown): RequestLineage | null {
	if (!isRecord(value)) return null
	const attribution = parseAttribution(value.attribution)
	if (!attribution) return null
	const credential = value.credential
	if (
		!isRecord(credential) ||
		typeof credential.kind !== 'string' ||
		!credentialKinds.has(credential.kind) ||
		typeof credential.orgId !== 'string'
	) {
		return null
	}
	const scopes = credential.scopes
	if (
		scopes !== null &&
		!(Array.isArray(scopes) && scopes.every((scope) => isOrgPermission(scope)))
	) {
		return null
	}
	const actorValue = value.actor
	let actor: RequestActor | null = null
	if (actorValue !== null) {
		if (!isRecord(actorValue) || typeof actorValue.userId !== 'string') {
			return null
		}
		actor = {
			userId: personIdFromStored(actorValue.userId),
			username: readNullableString(actorValue.username),
		}
	}
	let membership: RequestLineage['membership']
	if ('membership' in value) {
		const parsedMembership = parseMembership(value.membership)
		if (parsedMembership === undefined) return null
		membership = parsedMembership
	}
	return {
		actor,
		attribution,
		...(membership === undefined ? {} : { membership }),
		credential: {
			kind: credential.kind as RequestCredentialKind,
			id: readNullableString(credential.id),
			orgId: ownerIdFromStored(credential.orgId),
			scopes: scopes as RequestCredential['scopes'],
			profileName: readNullableString(credential.profileName),
		},
	}
}
