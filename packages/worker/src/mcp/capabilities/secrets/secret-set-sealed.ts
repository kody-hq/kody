import { type StorageContext } from '#mcp/storage.ts'
import {
	defaultCredentialInject,
	readStoredCredentialPlacement,
} from '#worker/credentials/credential-fields.ts'
import {
	type CredentialFillPlacement,
	serializeCredentialFillPlacement,
} from '#worker/credentials/fill-placement.ts'
import {
	openSealedTokenForSave,
	sealedTokenNameFromInput,
} from '#worker/credentials/sealed-token.ts'
import {
	orgAuditWriterFromCaller,
	orgAuditWriterFromRequest,
} from '#worker/orgs/org-audit.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { saveSecret } from '#mcp/secrets/service.ts'

/** A sealed token fills a header or the body; its saved Key keeps that. */
export const sealedTokenKeyPlacement: CredentialFillPlacement = {
	headers: true,
	body: true,
}

/** The part of a Key's placement a sealed token may use (headers, body). */
function narrowToSealedTokenPlacement(
	placement: CredentialFillPlacement | null,
): CredentialFillPlacement | null {
	if (placement === null) return sealedTokenKeyPlacement
	const narrowed: CredentialFillPlacement = {
		...(placement.headers !== undefined ? { headers: placement.headers } : {}),
		...(placement.body === true ? { body: true } : {}),
	}
	return Object.keys(narrowed).length > 0 ? narrowed : null
}

/**
 * Saves a sealed token from this run as the user-scope Key `name` (ADR 0068,
 * 2026-10-28): the host opens it and stores the value, which no caller ever
 * sees. The Key goes only to the exact hosts the token was minted for, in a
 * header or the body. The owner approved those hosts on the credentials that
 * minted it, so saving needs no new approval; it is audited like any Key.
 * Replacing an existing Key never widens it: hosts and placement are the
 * overlap of the Key's and the sealed token's, and its opt-ins are untouched.
 */
export async function saveSealedTokenSecret(
	ctx: CapabilityContext,
	input: {
		name: string
		sealedToken: string
		description?: string
		expiresAt?: string | null
		userEmail: string
		storageContext: StorageContext | null
	},
) {
	const sealedName = sealedTokenNameFromInput(input.sealedToken)
	if (!sealedName) {
		throw new McpCallerError(
			'sealed_token must be the {{integration-token:kody-sealed.…}} value a token request in this run returned (for example an access_token field).',
		)
	}
	const orgId = ownerIdFromCaller(ctx.callerContext)
	const opened = await openSealedTokenForSave({
		env: ctx.env,
		name: sealedName,
		org: orgId,
		binding: ctx.credentialClientBinding ?? null,
	})
	const name = input.name.trim()
	const existing = await readStoredCredentialPlacement({
		db: ctx.env.APP_DB,
		orgId,
		name,
	})
	if (existing && existing.kind !== 'secret') {
		throw new McpCallerError(
			`"${name}" is a ${existing.kind} credential. Save the sealed token under another name.`,
		)
	}
	// Replacing a Key keeps the owner's narrower hosts and placement.
	const hosts = existing
		? existing.allowedHosts.filter((host) => opened.hosts.includes(host))
		: opened.hosts
	if (hosts.length === 0) {
		throw new McpCallerError(
			`"${name}" is approved for hosts this sealed token may not go to. Save it under another name.`,
		)
	}
	const placement = existing
		? narrowToSealedTokenPlacement(existing.placement)
		: sealedTokenKeyPlacement
	if (!placement) {
		throw new McpCallerError(
			`"${name}" may not fill a header or the body, where a sealed token goes. Save it under another name.`,
		)
	}
	const saved = await saveSecret({
		env: ctx.env,
		audit: orgAuditWriterFromCaller(ctx.env, ctx.callerContext),
		userId: orgId,
		userEmail: input.userEmail,
		scope: 'user',
		name,
		value: opened.value,
		description: input.description ?? '',
		expiresAt: input.expiresAt,
		storageContext: input.storageContext,
		baseUrl: ctx.callerContext.baseUrl,
		credential: {
			kind: 'secret',
			allowedHosts: hosts,
			configJson: null,
			provider: existing?.provider ?? null,
			injectJson: JSON.stringify(existing?.inject ?? defaultCredentialInject),
			placementJson: serializeCredentialFillPlacement(placement),
			audit: {
				writer: orgAuditWriterFromRequest(
					ctx.env,
					requireMcpRequest(ctx.callerContext),
				),
				event: (credentialId) => ({
					orgId,
					action: 'credential.kind_set',
					resourceType: 'credential',
					resourceId: credentialId,
					details: {
						kind: { before: existing?.kind ?? null, after: 'secret' },
						hosts: {
							before: existing?.allowedHosts ?? null,
							after: hosts,
						},
						placement: {
							before: existing?.placement ?? null,
							after: placement,
						},
						savedFrom: 'sealed_token',
					},
				}),
			},
		},
		...(existing
			? {}
			: {
					fillPlacementOptInOnInsert: { query: false, path: false, body: true },
					fillPlacementOptInSource: 'sealed_token' as const,
				}),
	})
	return {
		saved,
		report: {
			kind: 'secret' as const,
			provider: existing?.provider ?? null,
			inject: existing?.inject ?? defaultCredentialInject,
			placement,
		},
	}
}
