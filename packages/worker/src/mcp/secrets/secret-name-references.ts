import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { McpCallerError } from '#mcp/caller-error.ts'

/** The names a `{{secret:<name>}}` placeholder can reference. */
const placeholderSecretNamePattern = /^[a-zA-Z0-9._-]+$/

/** A renamed secret must stay reachable from a placeholder. */
export function assertPlaceholderSecretName(name: string) {
	if (placeholderSecretNamePattern.test(name)) return
	throw new McpCallerError(
		`"${name}" is not a valid secret name. Use letters, numbers, dots, underscores, or hyphens so a {{secret:name}} placeholder can reference it.`,
	)
}

/**
 * Renaming keeps the credential id, so grants, package credential mappings,
 * and history follow. Anything that names the secret does not.
 */
export const secretRenameNameReferencesNote =
	'Renaming keeps the credential id, value, grants, package credential mappings, and history. References by name do not follow: {{secret:<old name>}} placeholders, package and execute code that names it, secretJwtSign calls, and scripts keep the old name and must be updated to the new one. Kody does not track references in package or execute source; known_references lists only the ones Kody stores.'

export type SecretNameReference = {
	kind: 'webhook-verification' | 'secret-provider-door'
	id: string
	package_id: string
	label: string
}

/**
 * The stored settings in `orgId` that name the user-scope secret `name`:
 * webhook verification secrets and secret provider door keys. Package and
 * execute source is not indexed, so its references are not included.
 */
export async function listKnownSecretNameReferences(input: {
	db: D1Database
	orgId: string
	name: string
}): Promise<Array<SecretNameReference>> {
	const [webhooks, providers] = await Promise.all([
		input.db
			.prepare(
				`SELECT id, package_id, webhook_name FROM webhook_endpoints
				WHERE user_id = ? AND (hmac_secret_name = ? OR previous_hmac_secret_name = ?)${andLiveDeletedAtSql()}
				ORDER BY webhook_name ASC, id ASC`,
			)
			.bind(input.orgId, input.name, input.name)
			.all<{ id: string; package_id: string; webhook_name: string }>(),
		input.db
			.prepare(
				`SELECT provider_id, package_id FROM secret_provider_bindings
				WHERE user_id = ? AND door_secret_name = ?${andLiveDeletedAtSql()}
				ORDER BY provider_id ASC`,
			)
			.bind(input.orgId, input.name)
			.all<{ provider_id: string; package_id: string }>(),
	])
	return [
		...(webhooks.results ?? []).map((row) => ({
			kind: 'webhook-verification' as const,
			id: row.id,
			package_id: row.package_id,
			label: `Webhook ${row.webhook_name} verification secret`,
		})),
		...(providers.results ?? []).map((row) => ({
			kind: 'secret-provider-door' as const,
			id: row.provider_id,
			package_id: row.package_id,
			label: `Secret provider ${row.provider_id} door key`,
		})),
	]
}
