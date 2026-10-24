/**
 * Every successful credential change leaves one org audit row naming what
 * changed, never the value. Covers the gaps that used to write no row:
 * create, replace, delete, disconnect, rename, allowed packages, and the
 * OAuth connection and MCP server equivalents.
 */
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import {
	deleteSecret,
	disconnectSecret,
	renameSecret,
	saveSecret,
	setSecretAllowedPackages,
} from '#mcp/secrets/service.ts'
import {
	deleteIntegration,
	setIntegrationUsage,
	upsertIntegration,
} from '#worker/integrations/service.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import {
	allowedPackagesAuditChange,
	credentialAuditEvent,
} from './credential-audit.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const userId = ownerIdFromStored('org-credential-audit')
const secretValue = 'first-value-never-audited'
const replacedValue = 'second-value-never-audited'

function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	const appDb = createD1FromSqlite(sqlite)
	const auditDb = createAuditTestDb()
	const env = {
		APP_DB: appDb,
		AUDIT_DB: auditDb,
		COOKIE_SECRET: 'test-cookie-secret',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		...createInMemoryUserMeterEnv().env,
	} as unknown as Env
	const audit = createTestOrgAuditWriter({
		appDb,
		db: auditDb,
		actorUserId: 'person-1',
	})
	const rows = async () => {
		const { results } = await auditDb
			.prepare(
				`SELECT action, resource_type, resource_id, result, details_json
				 FROM org_audit_events ORDER BY created_at, rowid`,
			)
			.all<{
				action: string
				resource_type: string
				resource_id: string
				result: string
				details_json: string
			}>()
		return results.map((row) => ({
			action: row.action,
			resourceType: row.resource_type,
			resourceId: row.resource_id,
			result: row.result,
			details: JSON.parse(row.details_json) as Record<string, unknown>,
		}))
	}
	return { env, audit, rows, auditDb }
}

const googleConfig = {
	name: 'google',
	tokenUrl: 'https://oauth2.googleapis.com/token',
	apiBaseUrl: 'https://www.googleapis.com',
	flow: 'pkce' as const,
	clientId: 'google-client-id-value',
	requiredHosts: ['www.googleapis.com'],
	authorization: {
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		scopes: ['openid'],
		scopeSeparator: null,
		extraAuthorizeParams: {},
	},
}

test('a user credential lifecycle audits each change once, without values', async () => {
	const { env, audit, rows, auditDb } = createEnv()
	const base = { env, userId, scope: 'user' as const, audit }
	await saveSecret({ ...base, name: 'apiKey', value: secretValue })
	// Same value again is not a change.
	await saveSecret({ ...base, name: 'apiKey', value: secretValue })
	await saveSecret({ ...base, name: 'apiKey', value: replacedValue })
	await saveSecret({
		...base,
		name: 'apiKey',
		value: replacedValue,
		description: 'Billing API',
	})
	await setSecretAllowedPackages({
		...base,
		name: 'apiKey',
		allowedPackages: ['pkg-billing'],
	})
	// Unchanged approvals write nothing.
	await setSecretAllowedPackages({
		...base,
		name: 'apiKey',
		allowedPackages: ['pkg-billing'],
	})
	await renameSecret({ ...base, fromName: 'apiKey', toName: 'billingKey' })
	await disconnectSecret({ ...base, name: 'billingKey' })
	await deleteSecret({ ...base, name: 'billingKey' })

	const audited = await rows()
	expect(audited.map((row) => row.action)).toEqual([
		'credential.created',
		'credential.value_replaced',
		'credential.details_updated',
		'credential.allowed_packages_updated',
		'credential.renamed',
		'credential.disconnected',
		'credential.deleted',
	])
	const ids = new Set(audited.map((row) => row.resourceId))
	expect(ids.size).toBe(1)
	expect(audited.every((row) => row.resourceType === 'credential')).toBe(true)
	expect(audited.every((row) => row.result === 'success')).toBe(true)
	expect(audited.map((row) => row.details.fields)).toEqual([
		[],
		['value'],
		['description'],
		['allowed_packages'],
		['name'],
		['connected'],
		[],
	])
	expect(audited[3]!.details.packages).toEqual({
		added: ['pkg-billing'],
		removed: [],
	})
	expect(audited[4]!.details).toMatchObject({
		previousName: 'apiKey',
		name: 'billingKey',
	})
	const raw = JSON.stringify(
		(await auditDb.prepare(`SELECT * FROM org_audit_events`).all()).results,
	)
	expect(raw).not.toContain(secretValue)
	expect(raw).not.toContain(replacedValue)
})

test('package and session values are not org credentials and write no row', async () => {
	const { env, audit, rows } = createEnv()
	await saveSecret({
		env,
		userId,
		scope: 'session',
		name: 'scratch',
		value: secretValue,
		storageContext: { sessionId: 'session-1', appId: null },
		sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
		audit,
	})
	expect(await rows()).toEqual([])
})

test('a null writer skips auditing without failing the write', async () => {
	const { env, rows } = createEnv()
	await saveSecret({
		env,
		userId,
		scope: 'user',
		name: 'apiKey',
		value: secretValue,
		audit: null,
	})
	expect(await rows()).toEqual([])
})

test('OAuth connections audit create, detail edits, package approvals, and delete', async () => {
	const { env, audit, rows } = createEnv()
	await upsertIntegration({ env, userId, config: googleConfig, audit })
	await upsertIntegration({ env, userId, config: googleConfig, audit })
	await upsertIntegration({
		env,
		userId,
		config: {
			...googleConfig,
			requiredHosts: ['www.googleapis.com', 'gmail.googleapis.com'],
		},
		description: 'Work mail',
		audit,
	})
	// An OAuth app setting edit names config, never the setting itself.
	await upsertIntegration({
		env,
		userId,
		config: {
			...googleConfig,
			requiredHosts: ['www.googleapis.com', 'gmail.googleapis.com'],
			clientId: 'google-client-id-rotated',
		},
		description: 'Work mail',
		audit,
	})
	await setIntegrationUsage({
		env,
		userId,
		name: 'google',
		usageMode: 'packages',
		allowedPackageIds: [],
		audit,
	})
	expect(await deleteIntegration({ env, userId, name: 'google', audit })).toBe(
		true,
	)
	const audited = await rows()
	expect(audited.map((row) => [row.action, row.details.fields])).toEqual([
		['credential.created', []],
		['credential.details_updated', ['description', 'hosts']],
		['credential.details_updated', ['config']],
		['credential.allowed_packages_updated', ['usage_mode']],
		['credential.deleted', []],
	])
	expect(JSON.stringify(audited)).not.toContain('google-client-id-rotated')
	expect(
		audited.every(
			(row) =>
				row.details.credentialKind === 'integration' &&
				row.details.name === 'google',
		),
	).toBe(true)
	expect(audited[3]!.details.usageMode).toEqual({
		before: 'any',
		after: 'packages',
	})
	expect(JSON.stringify(audited)).not.toContain('google-client-id-value')
})

test('allowed packages audit names only the parts that changed', () => {
	const credential = { id: 'cred-1', kind: 'integration' as const, name: 'gh' }
	const base = { orgId: 'org-1', credential }
	expect(
		allowedPackagesAuditChange({
			...base,
			before: { usageMode: 'all', allowedPackageIds: ['a'] },
			after: { usageMode: 'all', allowedPackageIds: ['a'] },
		}),
	).toBeNull()
	expect(
		allowedPackagesAuditChange({
			...base,
			before: { usageMode: 'all', allowedPackageIds: ['a'] },
			after: { usageMode: 'selected', allowedPackageIds: ['a'] },
		})?.details?.fields,
	).toEqual(['usage_mode'])
	expect(
		allowedPackagesAuditChange({
			...base,
			before: { usageMode: 'selected', allowedPackageIds: ['a'] },
			after: { usageMode: 'selected', allowedPackageIds: ['a', 'b'] },
		})?.details?.fields,
	).toEqual(['allowed_packages'])
})

test('credential identity in audit details cannot be overridden by extra details', () => {
	const event = credentialAuditEvent({
		orgId: 'org-1',
		credential: { id: 'cred-1', kind: 'secret', name: 'real' },
		action: 'credential.details_updated',
		details: { name: 'spoofed', credentialKind: 'integration', fields: [] },
	})
	expect(event.details).toMatchObject({
		name: 'real',
		credentialKind: 'secret',
	})
})
