/**
 * Convert a person's personal (signup) org into a general-purpose team org and
 * mint a new free personal org + username. Split migration: packages/plan/
 * webhooks stay on the converted org; person-private surfaces move to the new
 * personal org. See convert-personal-org-policy.ts for product knobs.
 */

import {
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	decryptSecretValue,
	decryptUserOauthAccessToken,
	decryptUserOauthClientSecret,
	decryptUserOauthRefreshToken,
	encryptSecretValue,
	encryptUserOauthAccessToken,
	encryptUserOauthClientSecret,
	encryptUserOauthRefreshToken,
	userIntegrationCredentialContext,
	userOauthAppCredentialContext,
	userSecretContext,
} from '#mcp/secrets/crypto.ts'
import {
	deleteMemoryVector,
	upsertMemoryVector,
} from '#mcp/memory/memory-vectorize.ts'
import { buildMemoryEmbedTextFromRow } from '#mcp/memory/memory-embed.ts'
import { type McpMemoryRow } from '#mcp/memory/types.ts'
import { ensureDefaultEmailInbox } from '#worker/email/default-inbox.ts'
import { getPlatformEmailDomain } from '#worker/email/platform-address.ts'
import { isUsernameClaimedInIdentity } from '#worker/identity/generated-username.ts'
import {
	getEffectiveUsernameValidationError,
	normalizeUsername,
} from '#worker/identity/username.ts'
import { mcpClientHubTransferStub } from '#worker/mcp-client/hub-transfer.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'
import { listUserOAuthGrants } from '#worker/oauth-grants.ts'
import {
	grantMatchesConsentOrg,
	readOrgIdFromGrantMetadata,
} from '#worker/orgs/oauth-grant.ts'
import {
	MAX_FREE_ORGS_PER_USER,
	countLiveFreeOwnedOrgs,
} from '#worker/orgs/billing.ts'
import {
	convertPersonalOrgEnforceFreeOrgCap,
	convertPersonalOrgKeepEmailOnConvertedOrg,
} from '#worker/orgs/convert-personal-org-policy.ts'
import { bumpAccessEpochStatement } from '#worker/authorization/access-compile.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import {
	loadPersonalOrgIdForPerson,
	mintOwnerId,
} from '#worker/orgs/personal-org-id.ts'
import { personalOrgProvisionStatements } from '#worker/orgs/provision.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export class ConvertPersonalOrgError extends Error {
	readonly code:
		| 'invalid_handle'
		| 'handle_taken'
		| 'not_personal'
		| 'credential_grants'
		| 'free_org_cap'
		| 'failed'

	constructor(
		message: string,
		code:
			| 'invalid_handle'
			| 'handle_taken'
			| 'not_personal'
			| 'credential_grants'
			| 'free_org_cap'
			| 'failed',
	) {
		super(message)
		this.name = 'ConvertPersonalOrgError'
		this.code = code
	}
}

export type ConvertPersonalOrgResult = {
	convertedOrgId: OwnerId
	convertedSlug: string
	newPersonalOrgId: OwnerId
	newUsername: string
	followUpFailures: Array<'oauth_grants' | 'email_inbox' | 'memory_index'>
	moved: {
		memories: number
		userSecrets: number
		integrations: number
		mcpServers: number
		apiTokens: number
		oauthGrants: number
		followsRetargeted: number
	}
}

type CryptoEnv = Pick<Env, 'SECRET_STORE_KEY'>

async function listLiveCredentialIdsForOwner(db: D1Database, ownerId: string) {
	const { results } = await db
		.prepare(
			`SELECT e.id AS id FROM secret_entries e
			 INNER JOIN secret_buckets b ON b.id = e.bucket_id
			 WHERE b.user_id = ? AND b.scope = 'user'
			   AND e.deleted_at IS NULL AND b.deleted_at IS NULL
			   AND e.id IS NOT NULL AND TRIM(e.id) != ''
			 UNION
			 SELECT i.id AS id FROM user_integrations i
			 WHERE i.user_id = ? AND i.deleted_at IS NULL
			   AND i.id IS NOT NULL AND TRIM(i.id) != ''
			 UNION
			 SELECT m.id AS id FROM mcp_server_settings m
			 WHERE m.user_id = ? AND m.deleted_at IS NULL
			   AND m.id IS NOT NULL AND TRIM(m.id) != ''`,
		)
		.bind(ownerId, ownerId, ownerId)
		.all<{ id: string }>()
	return (results ?? []).map((row) => row.id)
}

async function listCredentialOrgGrantNames(db: D1Database, personId: string) {
	const { results } = await db
		.prepare(
			`SELECT DISTINCT c.name AS name
			 FROM credential_org_grants g
			 LEFT JOIN secret_entries c
			   ON c.id = g.credential_id AND c.deleted_at IS NULL
			 WHERE g.user_id = ?
			 ORDER BY c.name ASC`,
		)
		.bind(personId)
		.all<{ name: string | null }>()
	return (results ?? [])
		.map((row) => row.name?.trim() || '(unnamed credential)')
		.filter(Boolean)
}

async function prepareUserSecretEntries(input: {
	env: CryptoEnv
	db: D1Database
	fromId: OwnerId
	toId: OwnerId
}) {
	const { results } = await input.db
		.prepare(
			`SELECT e.rowid AS rowid, e.id AS id, e.name AS name,
			        e.encrypted_value AS encrypted_value
			 FROM secret_entries e
			 INNER JOIN secret_buckets b ON b.id = e.bucket_id
			 WHERE b.user_id = ? AND b.scope = 'user'
			   AND e.deleted_at IS NULL AND b.deleted_at IS NULL`,
		)
		.bind(input.fromId)
		.all<{
			rowid: number
			id: string
			name: string
			encrypted_value: string
		}>()
	const statements: Array<D1PreparedStatement> = []
	let moved = 0
	for (const row of results ?? []) {
		if (!row.encrypted_value) continue
		const plaintext = await decryptSecretValue(
			input.env,
			row.encrypted_value,
			userSecretContext(input.fromId),
		)
		const ciphertext = await encryptSecretValue(
			input.env,
			plaintext,
			userSecretContext(input.toId),
		)
		statements.push(
			input.db
				.prepare(
					`UPDATE secret_entries SET encrypted_value = ? WHERE rowid = ? AND deleted_at IS NULL`,
				)
				.bind(ciphertext, row.rowid),
		)
		moved += 1
	}
	statements.push(
		input.db
			.prepare(`UPDATE secret_buckets SET user_id = ?
 WHERE user_id = ? AND scope = 'user' AND deleted_at IS NULL`)
			.bind(input.toId, input.fromId),
	)
	return { statements, moved }
}

/**
 * Move BYO OAuth apps and integrations together. They share a composite FK, so
 * the re-points run in one deferred-FK batch after ciphertext is resealed.
 */
async function prepareOauthAppsAndIntegrations(input: {
	env: CryptoEnv
	db: D1Database
	fromId: OwnerId
	toId: OwnerId
}) {
	const apps = await input.db
		.prepare(
			`SELECT rowid, slug, client_secret_encrypted
			 FROM user_oauth_apps
			 WHERE user_id = ? AND deleted_at IS NULL`,
		)
		.bind(input.fromId)
		.all<{
			rowid: number
			slug: string
			client_secret_encrypted: string | null
		}>()
	const integrations = await input.db
		.prepare(
			`SELECT rowid, id, name, access_token_encrypted, refresh_token_encrypted
			 FROM user_integrations
			 WHERE user_id = ? AND deleted_at IS NULL`,
		)
		.bind(input.fromId)
		.all<{
			rowid: number
			id: string
			name: string
			access_token_encrypted: string | null
			refresh_token_encrypted: string | null
		}>()

	const statements: Array<D1PreparedStatement> = []

	for (const row of apps.results ?? []) {
		const updates: Array<string> = []
		const binds: Array<string | number> = []
		if (row.client_secret_encrypted) {
			const plain = await decryptUserOauthClientSecret(
				input.env,
				row.client_secret_encrypted,
				userOauthAppCredentialContext(input.fromId, row.slug),
			)
			updates.push('client_secret_encrypted = ?')
			binds.push(
				await encryptUserOauthClientSecret(
					input.env,
					plain,
					userOauthAppCredentialContext(input.toId, row.slug),
				),
			)
		}
		// Keep logo_key on the existing R2 object. Rewriting the owner segment
		// without copying the blob would 404; org-transfer copies first.
		updates.push('user_id = ?')
		binds.push(input.toId, row.rowid)
		statements.push(
			input.db
				.prepare(
					`UPDATE user_oauth_apps SET ${updates.join(', ')}
					 WHERE rowid = ? AND deleted_at IS NULL`,
				)
				.bind(...binds),
		)
	}

	for (const row of integrations.results ?? []) {
		const updates: Array<string> = []
		const binds: Array<string | number> = []
		if (row.access_token_encrypted) {
			const plain = await decryptUserOauthAccessToken(
				input.env,
				row.access_token_encrypted,
				userIntegrationCredentialContext(input.fromId, row.name),
			)
			updates.push('access_token_encrypted = ?')
			binds.push(
				await encryptUserOauthAccessToken(
					input.env,
					plain,
					userIntegrationCredentialContext(input.toId, row.name),
				),
			)
		}
		if (row.refresh_token_encrypted) {
			const plain = await decryptUserOauthRefreshToken(
				input.env,
				row.refresh_token_encrypted,
				userIntegrationCredentialContext(input.fromId, row.name),
			)
			updates.push('refresh_token_encrypted = ?')
			binds.push(
				await encryptUserOauthRefreshToken(
					input.env,
					plain,
					userIntegrationCredentialContext(input.toId, row.name),
				),
			)
		}
		updates.push('user_id = ?')
		binds.push(input.toId, row.rowid)
		statements.push(
			input.db
				.prepare(
					`UPDATE user_integrations SET ${updates.join(', ')}
					 WHERE rowid = ? AND deleted_at IS NULL`,
				)
				.bind(...binds),
		)
	}

	return { statements, moved: (integrations.results ?? []).length }
}

type ConvertMcpServerRow = { id: string; name: string }

/**
 * Stage MCP hub copies onto the new personal org id before any irreversible
 * identity writes. Mirrors org-transfer: export + import only (no source
 * remove / target connect). On failure, discard already-staged imports.
 */
async function stageMcpServerTransfers(input: {
	env: Env
	db: D1Database
	fromId: OwnerId
	toId: OwnerId
}): Promise<Array<ConvertMcpServerRow>> {
	const { results } = await input.db
		.prepare(
			`SELECT id, name FROM mcp_server_settings
			 WHERE user_id = ? AND deleted_at IS NULL`,
		)
		.bind(input.fromId)
		.all<ConvertMcpServerRow>()
	const rows = results ?? []
	if (rows.length === 0) return []
	if (!input.env.MCP_CLIENT_HUB) {
		throw new ConvertPersonalOrgError(
			'Unable to move MCP server connections during conversion.',
			'failed',
		)
	}
	const sourceHub = mcpClientHubTransferStub({
		env: input.env,
		userId: input.fromId,
	})
	const targetHub = mcpClientHubTransferStub({
		env: input.env,
		userId: input.toId,
	})
	const staged: Array<ConvertMcpServerRow> = []
	try {
		for (const row of rows) {
			const transfer = await sourceHub.exportServerForTransfer({
				serverId: row.id,
			})
			if (!transfer) {
				throw new ConvertPersonalOrgError(
					`Unable to move MCP server "${row.name}" during conversion.`,
					'failed',
				)
			}
			const imported = await targetHub.importServerForTransfer(transfer)
			if (!imported.ok) {
				throw new ConvertPersonalOrgError(
					`Unable to import MCP server "${row.name}" during conversion.`,
					'failed',
				)
			}
			staged.push(row)
		}
	} catch (error) {
		for (const row of staged) {
			try {
				await targetHub.discardTransferredServer({ serverId: row.id })
			} catch {
				// Keep discarding remaining staged servers; preserve the
				// original convert/import error for the caller.
			}
		}
		throw error
	}
	return rows
}

async function discardStagedMcpServerTransfers(input: {
	env: Env
	toId: OwnerId
	servers: Array<ConvertMcpServerRow>
}) {
	if (input.servers.length === 0 || !input.env.MCP_CLIENT_HUB) return
	const targetHub = mcpClientHubTransferStub({
		env: input.env,
		userId: input.toId,
	})
	for (const row of input.servers) {
		try {
			await targetHub.discardTransferredServer({ serverId: row.id })
		} catch {
			// Best-effort cleanup; never replace the original convert error.
		}
	}
}

function mcpServerOwnershipStatements(input: {
	db: D1Database
	fromId: OwnerId
	toId: OwnerId
}) {
	return [
		input.db
			.prepare(
				`UPDATE mcp_server_settings SET user_id = ?
				 WHERE user_id = ? AND deleted_at IS NULL`,
			)
			.bind(input.toId, input.fromId),
		input.db
			.prepare(
				`UPDATE mcp_user_server_instructions SET user_id = ?
				 WHERE user_id = ? AND deleted_at IS NULL`,
			)
			.bind(input.toId, input.fromId),
	]
}

/**
 * After D1 ownership rewrite: close the source hub connection, then dial the
 * staged target. Best-effort — identity is already committed; staged hub state
 * plus rewritten `mcp_server_settings` is the recovery path.
 */
async function finalizeMcpServerTransfers(input: {
	env: Env
	fromId: OwnerId
	toId: OwnerId
	servers: Array<ConvertMcpServerRow>
}) {
	if (input.servers.length === 0 || !input.env.MCP_CLIENT_HUB) return
	const sourceHub = mcpClientHubTransferStub({
		env: input.env,
		userId: input.fromId,
	})
	const targetHub = mcpClientHubTransferStub({
		env: input.env,
		userId: input.toId,
	})
	for (const row of input.servers) {
		try {
			await sourceHub.removeServerForTransfer({ serverId: row.id })
			await targetHub.connectTransferredServer({ serverId: row.id })
		} catch {
			// Leave staged + D1-owned; operator recovery can reconnect later.
		}
	}
}

async function retargetOauthGrantMetadata(input: {
	env: Env
	personId: string
	fromOrgId: OwnerId
	toOrgId: OwnerId
}) {
	if (!input.env.OAUTH_KV) return 0
	const helpers = await resolveOAuthHelpers(input.env)
	if (!helpers || !('listUserGrants' in helpers)) return 0
	const grants = await listUserOAuthGrants(helpers, input.personId)
	let updated = 0
	for (const grant of grants) {
		if (
			!grantMatchesConsentOrg({
				metadata: grant.metadata,
				userId: input.personId,
				orgId: input.fromOrgId,
			})
		) {
			continue
		}
		const stamped = readOrgIdFromGrantMetadata(grant.metadata)
		// Pre-stamp grants fall back to person id; after convert that would
		// resolve to the converted equal-id org. Stamp the new personal org.
		if (stamped && stamped !== input.fromOrgId) continue
		const key = `grant:${input.personId}:${grant.id}`
		const stored = await input.env.OAUTH_KV.get(key, { type: 'json' })
		if (!stored || typeof stored !== 'object') continue
		const record = stored as { metadata?: Record<string, unknown> }
		const metadata =
			record.metadata && typeof record.metadata === 'object'
				? { ...record.metadata, orgId: input.toOrgId }
				: { orgId: input.toOrgId }
		await input.env.OAUTH_KV.put(key, JSON.stringify({ ...record, metadata }))
		updated += 1
	}
	return updated
}

async function reindexMovedMemories(input: {
	env: Env
	db: D1Database
	toId: OwnerId
}) {
	const { results } = await input.db
		.prepare(
			`SELECT * FROM mcp_memories
			 WHERE user_id = ? AND deleted_at IS NULL`,
		)
		.bind(input.toId)
		.all<McpMemoryRow & { user_id: string }>()
	let failed = false
	for (const row of results ?? []) {
		try {
			await deleteMemoryVector(input.env, row.id)
			await upsertMemoryVector(input.env, {
				memoryId: row.id,
				userId: input.toId,
				category: row.category,
				status: row.status,
				embedText: buildMemoryEmbedTextFromRow(row),
			})
		} catch {
			// D1 already moved. Report incomplete indexing without retrying conversion.
			failed = true
		}
	}
	return !failed
}

/**
 * Convert the caller's personal org into a team org keeping `@oldHandle`, and
 * mint `@newHandle` as the new personal org + username.
 */
export async function convertPersonalOrg(input: {
	env: Env
	personId: PersonId
	newHandle: string
	now?: Date
}): Promise<ConvertPersonalOrgResult> {
	const now = (input.now ?? new Date()).toISOString()
	const db = input.env.APP_DB
	const newUsername = normalizeUsername(input.newHandle)
	if (!newUsername) {
		throw new ConvertPersonalOrgError(
			'Enter a valid handle for your new personal account.',
			'invalid_handle',
		)
	}
	const usernameError = await getEffectiveUsernameValidationError(
		newUsername,
		input.env,
	)
	if (usernameError) {
		throw new ConvertPersonalOrgError(usernameError, 'invalid_handle')
	}

	const person = await db
		.prepare(
			`SELECT stable_user_id, username, personal_org_id, display_name, avatar_key
			 FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.personId)
		.first<{
			stable_user_id: string
			username: string
			personal_org_id: string | null
			display_name: string | null
			avatar_key: string | null
		}>()
	if (!person) {
		throw new ConvertPersonalOrgError('Account not found.', 'failed')
	}
	const convertedOrgId = await loadPersonalOrgIdForPerson(db, input.personId)
	if (!(await isPersonalOrg(db, convertedOrgId))) {
		throw new ConvertPersonalOrgError(
			'Only a personal organization can be converted.',
			'not_personal',
		)
	}
	const convertedOrg = await db
		.prepare(
			`SELECT id, slug, plan, display_name, avatar_key
			 FROM orgs WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(convertedOrgId)
		.first<{
			id: string
			slug: string
			plan: string
			display_name: string | null
			avatar_key: string | null
		}>()
	if (!convertedOrg) {
		throw new ConvertPersonalOrgError(
			'Personal organization not found.',
			'failed',
		)
	}
	if (newUsername === convertedOrg.slug || newUsername === person.username) {
		throw new ConvertPersonalOrgError(
			'Choose a new handle different from your current one.',
			'invalid_handle',
		)
	}
	if (await isUsernameClaimedInIdentity(db, newUsername)) {
		throw new ConvertPersonalOrgError(
			`@${newUsername} is already taken.`,
			'handle_taken',
		)
	}

	const grantNames = await listCredentialOrgGrantNames(db, input.personId)
	if (grantNames.length > 0) {
		throw new ConvertPersonalOrgError(
			`Revoke personal credentials granted into other organizations before converting: ${grantNames.join(', ')}.`,
			'credential_grants',
		)
	}

	if (convertPersonalOrgEnforceFreeOrgCap) {
		const freeCount = await countLiveFreeOwnedOrgs(db, input.personId)
		// Minting a free personal org increases free ownership by one while the
		// converted org still counts when it is free.
		if (freeCount >= MAX_FREE_ORGS_PER_USER) {
			throw new ConvertPersonalOrgError(
				`Converting would give you more than ${String(MAX_FREE_ORGS_PER_USER)} free organizations. Make one paid or delete one before converting.`,
				'free_org_cap',
			)
		}
	}

	// Fail closed before irreversible identity writes.
	let emailDomain: string | null = null
	if (convertPersonalOrgKeepEmailOnConvertedOrg) {
		emailDomain = getPlatformEmailDomain(input.env)
		if (!emailDomain) {
			throw new ConvertPersonalOrgError(
				'Outbound email is unavailable because no platform email domain is configured.',
				'failed',
			)
		}
	}
	const mcpServerCount = await db
		.prepare(
			`SELECT COUNT(*) AS count FROM mcp_server_settings
			 WHERE user_id = ? AND deleted_at IS NULL`,
		)
		.bind(convertedOrgId)
		.first<{ count: number }>()
	if ((mcpServerCount?.count ?? 0) > 0 && !input.env.MCP_CLIENT_HUB) {
		throw new ConvertPersonalOrgError(
			'Unable to move MCP server connections during conversion.',
			'failed',
		)
	}

	const newPersonalOrgId = mintOwnerId()
	const displayName = person.display_name ?? convertedOrg.display_name
	const avatarKey = person.avatar_key ?? convertedOrg.avatar_key

	// Prepare every ciphertext before provisioning or changing any D1 ownership.
	const userSecrets = await prepareUserSecretEntries({
		env: input.env,
		db,
		fromId: convertedOrgId,
		toId: newPersonalOrgId,
	})
	const integrations = await prepareOauthAppsAndIntegrations({
		env: input.env,
		db,
		fromId: convertedOrgId,
		toId: newPersonalOrgId,
	})
	const movedCredentialIds = await listLiveCredentialIdsForOwner(
		db,
		convertedOrgId,
	)
	const stagedMcpServers = await stageMcpServerTransfers({
		env: input.env,
		db,
		fromId: convertedOrgId,
		toId: newPersonalOrgId,
	})
	let committed = false
	try {
		const statements = [
			db.prepare('PRAGMA defer_foreign_keys = ON'),
			...personalOrgProvisionStatements(db, {
				stableUserId: input.personId,
				orgId: newPersonalOrgId,
				username: newUsername,
				createdAt: now,
				displayName,
				avatarKey,
				plan: 'free',
			}),
			db
				.prepare(
					`UPDATE handles SET user_id = NULL WHERE handle = ? AND org_id = ?`,
				)
				.bind(convertedOrg.slug, convertedOrgId),
			db
				.prepare(
					`UPDATE users SET username = ?, personal_org_id = ?, updated_at = ? WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
				)
				.bind(newUsername, newPersonalOrgId, now, input.personId),
			db
				.prepare(
					`UPDATE mcp_memories SET user_id = ? WHERE user_id = ? AND deleted_at IS NULL`,
				)
				.bind(newPersonalOrgId, convertedOrgId),
			db
				.prepare(
					`UPDATE mcp_memory_conversation_suppressions SET user_id = ? WHERE user_id = ?`,
				)
				.bind(newPersonalOrgId, convertedOrgId),
			...userSecrets.statements,
			...integrations.statements,
			...mcpServerOwnershipStatements({
				db,
				fromId: convertedOrgId,
				toId: newPersonalOrgId,
			}),
			db
				.prepare(
					`UPDATE grants SET deleted_at = ?, updated_at = ? WHERE org_id = ? AND resource_type = 'credential' AND deleted_at IS NULL AND resource_id IN (SELECT value FROM json_each(?))`,
				)
				.bind(now, now, convertedOrgId, JSON.stringify(movedCredentialIds)),
			db
				.prepare(
					`UPDATE api_tokens SET org_id = ?, updated_at = ? WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
				)
				.bind(newPersonalOrgId, now, convertedOrgId, input.personId),
			db
				.prepare(
					`UPDATE cli_credential_bootstrap_codes SET org_id = ? WHERE org_id = ? AND user_id = ?`,
				)
				.bind(newPersonalOrgId, convertedOrgId, input.personId),
			db
				.prepare(
					`UPDATE follows SET target_owner_id = ?, updated_at = ? WHERE target_owner_id = ? AND target_owner_id != ?`,
				)
				.bind(convertedOrgId, now, input.personId, convertedOrgId),
			bumpAccessEpochStatement(db, convertedOrgId),
			bumpAccessEpochStatement(db, newPersonalOrgId),
		]
		// The variable-length reseal plan precedes these fixed trailing writes.
		const tokenResultIndex = statements.length - 5
		const followsResultIndex = statements.length - 3
		const results = await db.batch(statements)
		committed = true
		await finalizeMcpServerTransfers({
			env: input.env,
			fromId: convertedOrgId,
			toId: newPersonalOrgId,
			servers: stagedMcpServers,
		})
		const followUpFailures: ConvertPersonalOrgResult['followUpFailures'] = []
		let oauthGrants = 0
		try {
			oauthGrants = await retargetOauthGrantMetadata({
				env: input.env,
				personId: input.personId,
				fromOrgId: convertedOrgId,
				toOrgId: newPersonalOrgId,
			})
		} catch {
			followUpFailures.push('oauth_grants')
		}

		if (convertPersonalOrgKeepEmailOnConvertedOrg && emailDomain) {
			try {
				const inbox = await ensureDefaultEmailInbox({
					db,
					userId: newPersonalOrgId,
					actorPersonId: input.personId,
					username: newUsername,
					domain: emailDomain,
				})
				if (!inbox) followUpFailures.push('email_inbox')
			} catch {
				followUpFailures.push('email_inbox')
			}
		}

		try {
			const indexed = await reindexMovedMemories({
				env: input.env,
				db,
				toId: newPersonalOrgId,
			})
			if (!indexed) followUpFailures.push('memory_index')
		} catch {
			followUpFailures.push('memory_index')
		}

		return {
			convertedOrgId,
			convertedSlug: convertedOrg.slug,
			newPersonalOrgId,
			newUsername,
			followUpFailures,
			moved: {
				memories: results[6]!.meta.changes ?? 0,
				userSecrets: userSecrets.moved,
				integrations: integrations.moved,
				mcpServers: stagedMcpServers.length,
				apiTokens: results[tokenResultIndex]!.meta.changes ?? 0,
				oauthGrants,
				followsRetargeted: results[followsResultIndex]!.meta.changes ?? 0,
			},
		}
	} catch (error) {
		if (!committed) {
			await discardStagedMcpServerTransfers({
				env: input.env,
				toId: newPersonalOrgId,
				servers: stagedMcpServers,
			})
		}
		throw error
	}
}
