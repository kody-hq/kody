import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { readNonEmptyTrimmedString } from '#app/request-body.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	AuthorizationError,
	authorize,
} from '#worker/authorization/authorize.ts'
import {
	parseCredentialHostsInput,
	updateCredentialHosts,
} from '#worker/credentials/credential-hosts.ts'
import {
	credentialPermissionFamily,
	credentialResource,
	getOrgCredential,
	missingCredentialResource,
} from '#worker/credentials/credential-ids.ts'
import { operationResult } from '#app/operation-result.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { type SetCredentialHostsResponse } from '#universal/credentials-list.ts'

export async function setCredentialHosts(input: {
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
	const rawHosts = (input.body as Record<string, unknown>)['hosts']
	if (!Array.isArray(rawHosts)) {
		return operationResult({ ok: false, error: 'Hosts must be a list.' }, 400)
	}
	const parsed = parseCredentialHostsInput(rawHosts)
	if (!parsed.ok) {
		return operationResult({ ok: false, error: parsed.error }, 400)
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
		await authorize(
			{ env: input.env, request },
			`${credentialPermissionFamily(credential.kind)}:write`,
			credentialResource(request.org.id, credential),
		)
		const updated = await updateCredentialHosts({
			db: input.env.APP_DB,
			orgId,
			credentialId: credential.id,
			hosts: parsed.hosts,
			audit: orgAuditWriterFromRequest(input.env, request),
		})
		return operationResult({
			ok: true,
			...updated,
		} satisfies SetCredentialHostsResponse)
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
