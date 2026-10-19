import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import { readNonEmptyTrimmedString } from '#app/request-body.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	AuthorizationError,
	authorize,
} from '#worker/authorization/authorize.ts'
import {
	credentialFillPlacementSchema,
	readCredentialFields,
	updateCredentialFields,
} from '#worker/credentials/credential-fields.ts'
import {
	credentialPermissionFamily,
	credentialResource,
	getOrgCredential,
	missingCredentialResource,
} from '#worker/credentials/credential-ids.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { type CredentialFillPlacementView } from '#universal/credential-fill-placement.ts'

export type SetCredentialPlacementResponse = {
	ok: true
	placement: CredentialFillPlacementView | null
	changed: boolean
}

export async function setCredentialPlacement(input: {
	env: Env
	user: AuthenticatedAppUser
	body: object
}) {
	const credentialId = readNonEmptyTrimmedString(input.body, 'credentialId')
	if (!credentialId) {
		return operationResult(
			{ ok: false, error: 'Credential id is required.' },
			400,
		)
	}
	const raw = (input.body as Record<string, unknown>)['placement']
	const parsed =
		raw === null
			? { success: true as const, data: null }
			: credentialFillPlacementSchema.safeParse(raw)
	if (!parsed.success) {
		return operationResult(
			{
				ok: false,
				error:
					parsed.error.issues[0]?.message ??
					'Placement must allow at least one request part.',
			},
			400,
		)
	}
	const request = input.user.request
	const orgId = ownerIdFromCaller({ request, user: input.user.mcpUser })
	try {
		const credential = await getOrgCredential(
			input.env.APP_DB,
			orgId,
			credentialId,
		)
		if (!credential?.live) {
			await authorize(
				{ env: input.env, request },
				'secret:write',
				missingCredentialResource(request.org.id, credentialId),
			)
			return operationResult(
				{ ok: false, error: 'No credential with that id in this org.' },
				404,
			)
		}
		if (credential.kind === 'mcp-server') {
			return operationResult(
				{
					ok: false,
					error: 'MCP servers have no placeholder fill placement.',
				},
				400,
			)
		}
		await authorize(
			{ env: input.env, request },
			`${credentialPermissionFamily(credential.kind)}:write`,
			credentialResource(request.org.id, credential),
		)
		const before = await readCredentialFields({
			db: input.env.APP_DB,
			credential,
		})
		const unchanged =
			JSON.stringify(before.placement) === JSON.stringify(parsed.data)
		if (unchanged) {
			return operationResult({
				ok: true,
				placement: before.placement,
				changed: false,
			} satisfies SetCredentialPlacementResponse)
		}
		const updated = await updateCredentialFields({
			db: input.env.APP_DB,
			orgId,
			credentialId: credential.id,
			update: { placement: parsed.data },
			audit: orgAuditWriterFromRequest(input.env, request),
		})
		return operationResult({
			ok: true,
			placement: updated.placement,
			changed: true,
		} satisfies SetCredentialPlacementResponse)
	} catch (error) {
		if (error instanceof AuthorizationError) {
			return operationResult({ ok: false, error: error.message }, 403)
		}
		if (error instanceof McpCallerError) {
			return operationResult({ ok: false, error: error.message }, 400)
		}
		throw error
	}
}
