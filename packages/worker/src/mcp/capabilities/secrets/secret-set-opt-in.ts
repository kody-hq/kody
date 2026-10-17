import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { z } from 'zod'
import {
	assertInjectFitsKind,
	assertLoginExchangeOnHosts,
	assertOptInCredentialValue,
	type CredentialFieldsUpdate,
	type CredentialFillPlacement,
	type CredentialInject,
	credentialFillPlacementSchema,
	credentialHostsSchema,
	credentialInjectSchema,
	credentialProviderSchema,
	defaultCredentialInject,
	loginExchangeSchema,
	normalizeCredentialHosts,
	type OptInStoredCredentialKind,
	optInStoredCredentialKinds,
	readStoredCredentialPlacement,
	serializeCredentialFillPlacement,
	updateCredentialFields,
} from '#worker/credentials/credential-fields.ts'
import {
	type OrgAuditOutboxEvent,
	type OrgAuditWriter,
	orgAuditWriterFromRequest,
} from '#worker/orgs/org-audit.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { type SaveSecretCredential } from '#mcp/secrets/service.ts'
import { type secretScopeValues } from '#mcp/secrets/types.ts'

const storedKindValues = ['secret', ...optInStoredCredentialKinds] as const

type StoredKind = (typeof storedKindValues)[number]

export const optInCredentialInputFields = {
	kind: z
		.enum(storedKindValues)
		.optional()
		.describe(
			'Optional credential kind (ADR 0068), set together with a value. "secret" (default) is a Key used by `{{secret:name}}` placeholders. "url", "login", and "signing" are opt-in kinds a package reads through a scoped credential client, never as raw text; they need `hosts`.',
		),
	hosts: credentialHostsSchema
		.optional()
		.describe(
			'Hosts an opt-in kind may be sent to: exact hosts or one wildcard level such as *.example.com. Set together with a value. Keys keep using host approvals instead.',
		),
	login_exchange: loginExchangeSchema
		.optional()
		.describe(
			'For kind "login": how the login fields are exchanged for a session token. Its url must be on one of `hosts`.',
		),
	provider: credentialProviderSchema
		.nullable()
		.optional()
		.describe(
			'Optional provider slug (for example "github") a scoped credential client matches package needs against. Null clears it. Keys used by placeholders ignore it.',
		),
	inject: credentialInjectSchema
		.optional()
		.describe(
			'Optional inject for a scoped credential client: a header with a "{value}" format, basic auth, or a query parameter. Defaults to `Authorization: Bearer {value}`. Placeholders ignore it.',
		),
	placement: credentialFillPlacementSchema
		.nullable()
		.optional()
		.describe(
			'Optional fill placement for placeholders (secret, secret-basic, and related forms): which request parts may receive the credential — headers (optionally named), query, path, and/or body. Null means anywhere. Distinct from inject, which only steers the scoped credential() client. The gateway does not enforce this yet.',
		),
}

type OptInInput = {
	name: string
	scope: (typeof secretScopeValues)[number]
	value?: string
	description?: string
	expires_at?: string | null
	kind?: StoredKind
	hosts?: Array<string>
	login_exchange?: z.infer<typeof loginExchangeSchema>
	provider?: string | null
	inject?: CredentialInject
	placement?: CredentialFillPlacement | null
}

type CredentialReport = {
	kind: StoredKind
	provider: string | null
	inject: CredentialInject
	placement: CredentialFillPlacement | null
}

export type OptInCredentialPlan =
	| { mode: 'none' }
	| {
			/** Saved by `saveSecret` in the same batch as the value. */
			mode: 'with-value'
			credential: Omit<SaveSecretCredential, 'audit'>
			auditEvent: (credentialId: string) => OrgAuditOutboxEvent
			report: CredentialReport
	  }
	| {
			/** Only provider and/or inject change; the entry itself is untouched. */
			mode: 'fields-only'
			credentialId: string
			kind: StoredKind
			update: CredentialFieldsUpdate
	  }

function isOptInKind(kind: StoredKind): kind is OptInStoredCredentialKind {
	return kind !== 'secret'
}

function exchangeHost(exchange: z.infer<typeof loginExchangeSchema> | null) {
	return exchange ? new URL(exchange.url).hostname : null
}

export async function planOptInCredentialFields(
	ctx: CapabilityContext,
	input: { input: OptInInput; authorityPackageId: string | null | undefined },
): Promise<OptInCredentialPlan> {
	return planOptInCredentialFieldsForOrg({
		db: ctx.env.APP_DB,
		orgId: ownerIdFromCaller(ctx.callerContext),
		...input,
	})
}

/**
 * Validates the opt-in fields before anything is written, so a bad kind,
 * host, or value fails without touching the stored secret. Only the org's
 * own user scope, outside package runtimes, carries these fields. Shared by
 * `secretSet` and the website save so both refuse the same inputs.
 */
export async function planOptInCredentialFieldsForOrg(input: {
	db: D1Database
	orgId: OwnerId
	input: OptInInput
	authorityPackageId: string | null | undefined
}): Promise<OptInCredentialPlan> {
	const { orgId } = input
	const {
		kind,
		hosts,
		login_exchange: loginExchange,
		provider,
		inject,
		placement,
		value,
	} = input.input
	const name = input.input.name.trim()
	const touchesKind =
		kind !== undefined || hosts !== undefined || loginExchange !== undefined
	const touchesFields =
		provider !== undefined || inject !== undefined || placement !== undefined
	const hasValue = typeof value === 'string' && value.length > 0
	if (!touchesKind && !touchesFields) {
		// A new value for an existing opt-in kind is still checked against it.
		if (input.input.scope !== 'user' || !hasValue) return { mode: 'none' }
	} else if (input.input.scope !== 'user' || input.authorityPackageId) {
		throw new McpCallerError(
			'kind, hosts, login_exchange, provider, inject, and placement apply only to user-scope secrets set outside a package.',
		)
	}
	if (touchesKind && !hasValue) {
		throw new McpCallerError(
			'Set kind, hosts, or login_exchange together with a value: whoever supplies the value decides where it may go.',
		)
	}
	const existing = await readStoredCredentialPlacement({
		db: input.db,
		orgId,
		name,
	})
	if (touchesFields && !hasValue) {
		if (!existing) {
			throw new McpCallerError(
				`No user-scope secret named "${name}" to update. Provide a value to create it.`,
			)
		}
		if (
			input.input.description !== undefined ||
			input.input.expires_at !== undefined
		) {
			throw new McpCallerError(
				'Without a value, change provider, inject, or placement in a call of their own, separate from description or expires_at.',
			)
		}
		if (inject) assertInjectFitsKind({ kind: existing.kind, inject })
		return {
			mode: 'fields-only',
			credentialId: existing.id,
			kind: existing.kind,
			update: {
				...(provider !== undefined ? { provider } : {}),
				...(inject ? { inject } : {}),
				...(placement !== undefined ? { placement } : {}),
			},
		}
	}
	const existingKind: StoredKind = existing?.kind ?? 'secret'
	const effectiveKind = kind ?? existingKind
	let allowedHosts: Array<string> | null = null
	let effectiveExchange: z.infer<typeof loginExchangeSchema> | null = null
	if (isOptInKind(effectiveKind)) {
		const effectiveHosts =
			(hosts && normalizeCredentialHosts(hosts)) ??
			(existingKind === effectiveKind && existing ? existing.allowedHosts : [])
		if (effectiveHosts.length === 0) {
			throw new McpCallerError(
				`A ${effectiveKind} credential needs hosts: the hosts it may be sent to.`,
			)
		}
		if (effectiveKind === 'login') {
			effectiveExchange =
				loginExchange ??
				(existingKind === 'login' ? (existing?.loginExchange ?? null) : null)
			if (!effectiveExchange) {
				throw new McpCallerError(
					'A login credential needs login_exchange: how its fields become a session token.',
				)
			}
			assertLoginExchangeOnHosts({
				exchangeUrl: effectiveExchange.url,
				hosts: effectiveHosts,
			})
		} else if (loginExchange !== undefined) {
			throw new McpCallerError('login_exchange applies only to kind "login".')
		}
		assertOptInCredentialValue({
			kind: effectiveKind,
			value: value as string,
			hosts: effectiveHosts,
		})
		allowedHosts = effectiveHosts
	} else {
		if (hosts !== undefined) {
			throw new McpCallerError(
				'hosts apply only to the opt-in kinds (url, login, signing). A Key gets its hosts through host approvals.',
			)
		}
		if (loginExchange !== undefined) {
			throw new McpCallerError('login_exchange applies only to kind "login".')
		}
		// Back to a Key: its hosts come only from the approval flow again.
		if (existingKind !== 'secret') allowedHosts = []
	}
	if (!touchesKind && !touchesFields) return { mode: 'none' }
	const before = {
		provider: existing?.provider ?? null,
		inject: existing?.inject ?? defaultCredentialInject,
		placement: existing?.placement ?? null,
	}
	const report: CredentialReport = {
		kind: effectiveKind,
		provider: provider === undefined ? before.provider : provider,
		inject: inject ?? before.inject,
		placement: placement === undefined ? before.placement : placement,
	}
	assertInjectFitsKind({ kind: report.kind, inject: report.inject })
	const fieldDetails = touchesFields
		? {
				provider: { before: before.provider, after: report.provider },
				inject: { before: before.inject, after: report.inject },
				placement: { before: before.placement, after: report.placement },
			}
		: {}
	return {
		mode: 'with-value',
		credential: {
			kind: effectiveKind,
			allowedHosts,
			configJson: effectiveExchange ? JSON.stringify(effectiveExchange) : null,
			provider: report.provider,
			injectJson: JSON.stringify(report.inject),
			placementJson: serializeCredentialFillPlacement(report.placement),
		},
		auditEvent: (credentialId) =>
			touchesKind
				? {
						orgId,
						action: 'credential.kind_set',
						resourceType: 'credential',
						resourceId: credentialId,
						details: {
							kind: { before: existing?.kind ?? null, after: effectiveKind },
							hosts: {
								before: existing?.allowedHosts ?? null,
								after: allowedHosts ?? existing?.allowedHosts ?? [],
							},
							loginExchangeHost: {
								before: exchangeHost(existing?.loginExchange ?? null),
								after: exchangeHost(effectiveExchange),
							},
							...fieldDetails,
						},
					}
				: {
						orgId,
						action: 'credential.fields_updated',
						resourceType: 'credential',
						resourceId: credentialId,
						details: { credentialKind: 'secret', ...fieldDetails },
					},
		report,
	}
}

/** The `saveSecret` credential input for a plan that saves with the value. */
export function toSaveSecretCredential(
	ctx: CapabilityContext,
	plan: Extract<OptInCredentialPlan, { mode: 'with-value' }>,
): SaveSecretCredential {
	return withCredentialAudit(
		plan,
		orgAuditWriterFromRequest(ctx.env, requireMcpRequest(ctx.callerContext)),
	)
}

export function withCredentialAudit(
	plan: Extract<OptInCredentialPlan, { mode: 'with-value' }>,
	writer: OrgAuditWriter,
): SaveSecretCredential {
	return { ...plan.credential, audit: { writer, event: plan.auditEvent } }
}

/** Applies a provider/inject-only plan without rewriting the secret entry. */
export async function applyCredentialFieldsOnly(
	ctx: CapabilityContext,
	plan: Extract<OptInCredentialPlan, { mode: 'fields-only' }>,
): Promise<CredentialReport> {
	const updated = await updateCredentialFields({
		db: ctx.env.APP_DB,
		orgId: ownerIdFromCaller(ctx.callerContext),
		credentialId: plan.credentialId,
		update: plan.update,
		audit: orgAuditWriterFromRequest(
			ctx.env,
			requireMcpRequest(ctx.callerContext),
		),
	})
	return {
		kind: plan.kind,
		provider: updated.provider,
		inject: updated.inject,
		placement: updated.placement,
	}
}
