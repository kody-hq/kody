import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { parseApiToken } from '@kody-internal/shared/api-token-format.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	cliBootstrapCodePrefix,
	cliCredentialBootstrapPolicy,
	mintCliCredentialBootstrap,
	parseCliBootstrapCode,
	redeemCliCredentialBootstrap,
} from './cli-credential-bootstrap.ts'
import {
	apiTokenLifetimeAliases,
	apiTokenPolicy,
	authenticateApiToken,
} from './service.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const userId = ownerIdFromStored('stable-user-bootstrap-1')
const start = new Date('2026-10-01T12:00:00.000Z')
const shortLife = apiTokenLifetimeAliases.short
const longLife = apiTokenLifetimeAliases.long

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			 VALUES ('bootstrap-user', 'bootstrap@example.com', 'hash', ?)`,
		)
		.run(userId)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function at(seconds: number) {
	return new Date(start.getTime() + seconds * 1000)
}

test('bootstrap mint requires a lifetime and embeds it in cli_command', async () => {
	const { db } = createDb()
	await expect(
		mintCliCredentialBootstrap({
			db,
			userId,
			now: start,
		}),
	).rejects.toThrow(/Token lifetime is required/)
	await expect(
		mintCliCredentialBootstrap({
			db,
			userId,
			now: start,
		}),
	).rejects.toThrow(/lifetime: "short"\|"long"/)

	const minted = await mintCliCredentialBootstrap({
		db,
		userId,
		lifetime: 'short',
		now: start,
	})

	expect(minted.bootstrap_code.startsWith(cliBootstrapCodePrefix)).toBe(true)
	expect(minted.cli_command).toBe(
		`npx @kodycodes/cli auth bootstrap --code ${minted.bootstrap_code} --lifetime short`,
	)
	expect(minted.scopes).toEqual([...cliCredentialBootstrapPolicy.defaultScopes])
	expect(minted.scopes).toContain('integration:read')
	expect(minted.scopes).toContain('secret:use')
	expect(minted.scopes).toContain('package:execute')
	expect(minted.scopes).toContain('package:write')
	expect(minted.scopes).toContain('package:create')
	expect(minted.scopes).toContain('token:delete')
	expect(minted.idle_ttl_seconds).toBe(shortLife.idleTtlSeconds)
	expect(minted.max_lifetime_seconds).toBe(shortLife.maxLifetimeSeconds)
	expect(parseApiToken(minted.bootstrap_code)).toBeNull()
	expect(parseCliBootstrapCode(minted.bootstrap_code)?.codeId).toBeTruthy()
})

test('bootstrap redeem requires a lifetime and yields a working token', async () => {
	const { db } = createDb()
	const minted = await mintCliCredentialBootstrap({
		db,
		userId,
		lifetime: 'long',
		now: start,
	})
	await expect(
		redeemCliCredentialBootstrap({
			db,
			code: minted.bootstrap_code,
			now: at(30),
		}),
	).rejects.toThrow(/Token lifetime is required/)
	await expect(
		redeemCliCredentialBootstrap({
			db,
			code: minted.bootstrap_code,
			now: at(30),
		}),
	).rejects.toThrow(/--lifetime short\|long/)

	const redeemed = await redeemCliCredentialBootstrap({
		db,
		code: minted.bootstrap_code,
		lifetime: 'long',
		now: at(30),
	})
	expect(redeemed.userId).toBe(userId)
	expect(redeemed.token.created_via).toBe('cli-bootstrap')
	expect(redeemed.token.scopes).toEqual([
		...cliCredentialBootstrapPolicy.defaultScopes,
	])
	expect(redeemed.token.idle_ttl_seconds).toBe(longLife.idleTtlSeconds)
	expect(redeemed.token.expires_at).toBe(
		at(30 + longLife.idleTtlSeconds).toISOString(),
	)
	// Absolute expiry is anchored to code created_at + authorized max, not
	// restarted from redeem time.
	expect(redeemed.token.max_expires_at).toBe(
		at(longLife.maxLifetimeSeconds).toISOString(),
	)
	const auth = await authenticateApiToken({
		db,
		token: redeemed.token.token,
		now: at(60),
	})
	expect(auth.ok && auth.record.user_id).toBe(userId)

	await expect(
		redeemCliCredentialBootstrap({
			db,
			code: minted.bootstrap_code,
			lifetime: 'short',
			now: at(90),
		}),
	).rejects.toBeInstanceOf(McpCallerError)
})

test('bootstrap redeem rejects a lifetime longer than the code authorized', async () => {
	const { db } = createDb()
	const minted = await mintCliCredentialBootstrap({
		db,
		userId,
		lifetime: 'short',
		now: start,
	})
	await expect(
		redeemCliCredentialBootstrap({
			db,
			code: minted.bootstrap_code,
			lifetime: 'long',
			now: at(30),
		}),
	).rejects.toThrow(/cannot exceed the bootstrap code's authorized/)
})

test('bootstrap redeem rejects when the authorized absolute window already ended', async () => {
	const { db, sqlite } = createDb()
	const minted = await mintCliCredentialBootstrap({
		db,
		userId,
		idleTtlSeconds: 60,
		maxLifetimeSeconds: 60,
		redeemTtlSeconds: 600,
		now: start,
	})
	await expect(
		redeemCliCredentialBootstrap({
			db,
			code: minted.bootstrap_code,
			idleTtlSeconds: 60,
			maxLifetimeSeconds: 60,
			now: at(61),
		}),
	).rejects.toThrow(/authorized token lifetime window has already ended/)
	expect(
		sqlite
			.prepare(
				'SELECT consumed_at FROM cli_credential_bootstrap_codes WHERE user_id = ?',
			)
			.get(userId),
	).toMatchObject({ consumed_at: null })
})

test('bootstrap redeem accepts explicit idle and max lifetime values', async () => {
	const { db } = createDb()
	const minted = await mintCliCredentialBootstrap({
		db,
		userId,
		idleTtlSeconds: 180,
		maxLifetimeSeconds: 900,
		now: start,
	})
	expect(minted.cli_command).toContain('--idle-ttl-seconds 180')
	expect(minted.cli_command).toContain('--max-lifetime-seconds 900')

	const redeemed = await redeemCliCredentialBootstrap({
		db,
		code: minted.bootstrap_code,
		idleTtlSeconds: 120,
		maxLifetimeSeconds: 600,
		now: at(30),
	})
	expect(redeemed.token.idle_ttl_seconds).toBe(120)
	expect(redeemed.token.max_expires_at).toBe(at(30 + 600).toISOString())
})

test('bootstrap rejects idle or max lifetime values above the policy caps', async () => {
	const { db } = createDb()
	await expect(
		mintCliCredentialBootstrap({
			db,
			userId,
			idleTtlSeconds: apiTokenPolicy.maxIdleTtlSeconds + 1,
			maxLifetimeSeconds: apiTokenPolicy.maxMaxLifetimeSeconds,
			now: start,
		}),
	).rejects.toThrow(/idle_ttl_seconds/)
	await expect(
		mintCliCredentialBootstrap({
			db,
			userId,
			idleTtlSeconds: 120,
			maxLifetimeSeconds: apiTokenPolicy.maxMaxLifetimeSeconds + 1,
			now: start,
		}),
	).rejects.toThrow(/max_lifetime_seconds/)
})

test('bootstrap redeem rejects expired codes', async () => {
	const { db } = createDb()
	const minted = await mintCliCredentialBootstrap({
		db,
		userId,
		lifetime: 'short',
		redeemTtlSeconds: 60,
		now: start,
	})
	await expect(
		redeemCliCredentialBootstrap({
			db,
			code: minted.bootstrap_code,
			lifetime: 'short',
			now: at(120),
		}),
	).rejects.toThrow(/expired/i)
})

test('bootstrap codes issued before a password change are burned and rejected', async () => {
	const { db, sqlite } = createDb()
	const minted = await mintCliCredentialBootstrap({
		db,
		userId,
		lifetime: 'short',
		now: start,
	})
	sqlite
		.prepare(
			'UPDATE users SET password_changed_at = ? WHERE stable_user_id = ?',
		)
		.run(at(30).toISOString(), userId)

	await expect(
		redeemCliCredentialBootstrap({
			db,
			code: minted.bootstrap_code,
			lifetime: 'short',
			now: at(60),
		}),
	).rejects.toThrow('Invalid CLI bootstrap code.')
	expect(
		sqlite
			.prepare(
				'SELECT consumed_at FROM cli_credential_bootstrap_codes WHERE user_id = ?',
			)
			.get(userId),
	).toMatchObject({ consumed_at: at(60).toISOString() })
})

test('bootstrap codes issued after a password change can be redeemed', async () => {
	const { db, sqlite } = createDb()
	sqlite
		.prepare(
			'UPDATE users SET password_changed_at = ? WHERE stable_user_id = ?',
		)
		.run(at(30).toISOString(), userId)
	const minted = await mintCliCredentialBootstrap({
		db,
		userId,
		lifetime: 'short',
		now: at(60),
	})

	const redeemed = await redeemCliCredentialBootstrap({
		db,
		code: minted.bootstrap_code,
		lifetime: 'short',
		now: at(90),
	})
	expect(redeemed.userId).toBe(userId)
})

test('bootstrap codes for suspended users are burned and rejected generically', async () => {
	const { db, sqlite } = createDb()
	const minted = await mintCliCredentialBootstrap({
		db,
		userId,
		lifetime: 'short',
		now: start,
	})
	sqlite
		.prepare('UPDATE users SET suspended_at = ? WHERE stable_user_id = ?')
		.run(at(30).toISOString(), userId)

	await expect(
		redeemCliCredentialBootstrap({
			db,
			code: minted.bootstrap_code,
			lifetime: 'short',
			now: at(60),
		}),
	).rejects.toThrow('Invalid CLI bootstrap code.')
	expect(
		sqlite
			.prepare(
				'SELECT consumed_at FROM cli_credential_bootstrap_codes WHERE user_id = ?',
			)
			.get(userId),
	).toMatchObject({ consumed_at: at(60).toISOString() })
})

test('bootstrap respects parent token scopes', async () => {
	const { db } = createDb()
	await expect(
		mintCliCredentialBootstrap({
			db,
			userId,
			lifetime: 'short',
			scopes: ['org:execute', 'package:write'],
			parent: {
				scopes: ['token:delete', 'org:execute', 'org:read'],
				maxExpiresAt: at(24 * 60 * 60).toISOString(),
			},
			now: start,
		}),
	).rejects.toThrow(/scopes it does not hold/)
})

test('bootstrap without explicit scopes intersects defaults with the parent', async () => {
	const { db } = createDb()
	const minted = await mintCliCredentialBootstrap({
		db,
		userId,
		lifetime: 'short',
		parent: {
			scopes: ['token:delete', 'org:execute', 'org:read'],
			maxExpiresAt: at(24 * 60 * 60).toISOString(),
		},
		now: start,
	})
	expect(minted.scopes).toEqual(['org:execute', 'org:read', 'token:delete'])
})

test('bootstrap long lifetime clamps absolute max to a shorter API-token parent', async () => {
	const { db } = createDb()
	const parentRemainingSeconds = 30 * 24 * 60 * 60
	const minted = await mintCliCredentialBootstrap({
		db,
		userId,
		lifetime: 'long',
		parent: {
			scopes: ['token:delete', 'org:execute', 'org:read', 'package:execute'],
			maxExpiresAt: at(parentRemainingSeconds).toISOString(),
		},
		now: start,
	})
	expect(minted.idle_ttl_seconds).toBe(longLife.idleTtlSeconds)
	expect(minted.max_lifetime_seconds).toBe(parentRemainingSeconds)
	expect(minted.max_lifetime_seconds).toBeLessThan(longLife.maxLifetimeSeconds)
	const idleFlag = minted.cli_command.match(/--idle-ttl-seconds (\d+)/)?.[1]
	const maxFlag = minted.cli_command.match(/--max-lifetime-seconds (\d+)/)?.[1]
	expect(idleFlag).toBe(String(longLife.idleTtlSeconds))
	expect(maxFlag).toBe(String(parentRemainingSeconds))
	expect(minted.cli_command).not.toMatch(/--lifetime\s+long/)

	const redeemed = await redeemCliCredentialBootstrap({
		db,
		code: minted.bootstrap_code,
		idleTtlSeconds: Number(idleFlag),
		maxLifetimeSeconds: Number(maxFlag),
		now: start,
	})
	expect(redeemed.token.idle_ttl_seconds).toBe(longLife.idleTtlSeconds)
	expect(redeemed.token.max_expires_at).toBe(
		at(parentRemainingSeconds).toISOString(),
	)
})

test('bootstrap redeem keeps the stored org_id and rejects a missing one', async () => {
	const { db, sqlite } = createDb()
	const orgId = ownerIdFromStored('org-bootstrap-team')
	const minted = await mintCliCredentialBootstrap({
		db,
		userId,
		orgBinding: 'org',
		orgId: `  ${orgId}  `,
		lifetime: 'short',
		now: start,
	})
	const redeemed = await redeemCliCredentialBootstrap({
		db,
		code: minted.bootstrap_code,
		lifetime: 'short',
		now: at(10),
	})
	expect(redeemed.token.org_id).toBe(orgId)
	expect(redeemed.token.org_binding).toBe('org')

	const missing = await mintCliCredentialBootstrap({
		db,
		userId,
		orgBinding: 'org',
		orgId,
		lifetime: 'short',
		now: start,
	})
	const missingId = parseCliBootstrapCode(missing.bootstrap_code)?.codeId
	if (!missingId) throw new Error('expected a bootstrap code id')
	sqlite
		.prepare(
			`UPDATE cli_credential_bootstrap_codes SET org_id = NULL WHERE id = ?`,
		)
		.run(missingId)
	await expect(
		redeemCliCredentialBootstrap({
			db,
			code: missing.bootstrap_code,
			lifetime: 'short',
			now: at(20),
		}),
	).rejects.toThrow(/missing an org binding/)
	expect(
		sqlite
			.prepare(
				`SELECT consumed_at FROM cli_credential_bootstrap_codes WHERE id = ?`,
			)
			.get(missingId),
	).toMatchObject({ consumed_at: null })

	sqlite
		.prepare(
			`UPDATE cli_credential_bootstrap_codes SET org_id = '   ' WHERE id = ?`,
		)
		.run(missingId)
	await expect(
		redeemCliCredentialBootstrap({
			db,
			code: missing.bootstrap_code,
			lifetime: 'short',
			now: at(30),
		}),
	).rejects.toThrow(/missing an org binding/)
	expect(
		sqlite.prepare(`SELECT COUNT(*) AS count FROM api_tokens`).get() as {
			count: number
		},
	).toMatchObject({ count: 1 })
	expect(
		sqlite.prepare(`SELECT org_id FROM api_tokens`).get() as { org_id: string },
	).toEqual({ org_id: orgId })
})

test('bootstrap still rejects an explicit idle TTL longer than the parent', async () => {
	const { db } = createDb()
	await expect(
		mintCliCredentialBootstrap({
			db,
			userId,
			idleTtlSeconds: 14 * 24 * 60 * 60,
			maxLifetimeSeconds: 14 * 24 * 60 * 60,
			parent: {
				scopes: ['token:delete', 'org:execute', 'org:read', 'package:execute'],
				maxExpiresAt: at(6 * 24 * 60 * 60).toISOString(),
			},
			now: start,
		}),
	).rejects.toThrow(/expires too soon/)
})
