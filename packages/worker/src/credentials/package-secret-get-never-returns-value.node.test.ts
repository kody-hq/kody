/**
 * Invariant: secret values never enter package or user code. Every
 * package-facing `packageSecrets.get` path returns an opaque `{{secret:…}}`
 * ref that only the fetch gateway fills in. No slot kind, manifest flag, or
 * consent configuration hands package code the plaintext.
 *
 * Real boundary: migrated APP_DB, real saved secrets and package grants, real
 * manifest parsing, and the unmocked local-execute capability proxy.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import * as secretService from '#mcp/secrets/service.ts'
import { createCapabilityProxyPackageHostTools } from '#worker/open-api/capability-proxy-package-grants.ts'
import { signLocalExecutePackageBinding } from '#worker/package-runtime/local-execute-package-binding.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import * as packageSource from '#worker/package-registry/source.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import * as needsClosure from './credential-needs-closure.ts'
import * as stampPresence from './credential-stamp-presence.ts'
import { attestedPackageStamp, claimedPackageStamp } from './package-stamp.ts'
import { resolveCredential } from './resolve-credential.ts'

vi.mock(
	'#worker/test-support/apply-all-migrations.ts',
	async (importOriginal) =>
		(await import('./cached-migrations.test-support.ts')).withCachedMigrations(
			await importOriginal(),
		),
)

vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof import('cloudflare:workers')>()),
	waitUntil: () => {},
}))

const now = '2026-10-11T00:00:00.000Z'
const values = {
	SIGNING_KEY: 'plaintext-signing-key-value',
	HEADER_KEY: 'plaintext-header-key-value',
	HOSTED_KEY: 'plaintext-hosted-key-value',
	UNGRANTED_KEY: 'plaintext-ungranted-key-value',
}

const credentialSlots = {
	SIGNING_KEY: {
		kind: 'secret',
		provider: 'aws',
		description: 'Signing key.',
	},
	HEADER_KEY: {
		kind: 'secret',
		provider: 'resend',
		description: 'API key.',
	},
	GOOGLE: { kind: 'oauth', provider: 'google', description: 'Google.' },
}

function manifestJson(slots: Record<string, unknown>) {
	return JSON.stringify({
		name: '@owner/signer',
		exports: { '.': './index.ts' },
		kody: {
			description: 'Signs requests.',
			credentials: slots,
			secretMounts: Object.fromEntries(
				Object.keys(values).map((name) => [name, { name, scope: 'user' }]),
			),
		},
	})
}

function expectNoPlaintext(output: unknown) {
	const text =
		output instanceof Error
			? `${output.message}\n${String(output.stack)}`
			: JSON.stringify(output)
	for (const value of Object.values(values)) {
		expect(text).not.toContain(value)
	}
}

async function settle<T>(promise: Promise<T>) {
	return promise.then(
		(result) => ({ ok: true as const, result }),
		(error: unknown) => ({ ok: false as const, error }),
	)
}

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const ownerStableId = testStableUserIdFromEmail('owner@example.com')
	const orgId = ownerIdFromStored(ownerStableId)
	await provisionPersonalOrg(db, {
		stableUserId: ownerStableId,
		username: 'owner',
		createdAt: now,
	})
	const packageId = crypto.randomUUID()
	await insertSavedPackage(
		db,
		{
			id: packageId,
			user_id: orgId,
			name: '@owner/signer',
			kody_id: 'signer',
			description: 'signer',
			tags_json: '[]',
			search_text: null,
			source_id: `source-${packageId}`,
			has_app: 0,
			has_skills: 0,
			hidden: 0,
			is_private: 1,
			created_at: now,
			updated_at: now,
		},
		null,
		{ stamp: false },
	)
	const env = {
		APP_DB: db,
		AUDIT_DB: createAuditTestDb(),
		...createInMemoryUserMeterEnv().env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	for (const [name, value] of Object.entries(values)) {
		await secretService.saveSecret({
			env,
			userId: orgId,
			scope: 'user',
			name,
			value,
		})
		if (name === 'UNGRANTED_KEY') continue
		await secretService.lockSecretToPackage({
			env,
			userId: orgId,
			name,
			packageId,
		})
	}
	await secretService.setSecretAllowedHosts({
		env,
		userId: orgId,
		name: 'HOSTED_KEY',
		scope: 'user',
		allowedHosts: ['api.example.com'],
	})
	vi.spyOn(packageSource, 'loadPackageManifestBySourceId').mockResolvedValue({
		source: {} as packageSource.LoadedPackageManifest['source'],
		manifest: parseAuthoredPackageJson({
			content: manifestJson(credentialSlots),
			mode: 'published',
		}),
	})
	const callerContext = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://example.com',
		user: {
			userId: personIdFromStored(ownerStableId),
			username: 'owner',
			email: 'owner@example.com',
			displayName: 'Owner',
		},
		orgBinding: { org: { id: orgId, slug: 'owner' }, role: 'owner' },
		storageContext: {
			sessionId: null,
			appId: null,
			packageId,
			storageId: null,
		},
	})
	const resolve = (
		alias: string,
		stamp: typeof attestedPackageStamp,
		access?: 'presence' | 'value',
	) =>
		resolveCredential({
			env,
			orgId,
			actor: callerContext.request,
			packageStamp: stamp(packageId),
			baseUrl: 'https://example.com',
			credential: {
				use: 'package-secret-mount',
				alias,
				callerContext,
				...(access ? { access } : {}),
			},
		})
	// CapabilityProxy takes the package graph's signed binding, never the id.
	const packageBinding = await signLocalExecutePackageBinding({
		env,
		packageId,
		subject: {
			org: orgId,
			actor: callerContext.request?.actor?.userId ?? null,
		},
	})
	return { env, packageId, packageBinding, callerContext, resolve }
}

const aliases = [...Object.keys(values), 'GOOGLE', 'UNKNOWN']

test('packageSecrets.get resolves only opaque refs for every alias, stamp, and grant', async () => {
	const t = await setup()
	for (const stamp of [attestedPackageStamp, claimedPackageStamp]) {
		for (const alias of aliases) {
			const outcome = await settle(t.resolve(alias, stamp))
			if (!outcome.ok) {
				expectNoPlaintext(outcome.error)
				continue
			}
			expect(outcome.result).not.toHaveProperty('value')
			expect(outcome.result.ref).toBe(`{{secret:${alias}|scope=user}}`)
			expectNoPlaintext(outcome.result)
		}
	}
	const granted = await t.resolve('SIGNING_KEY', attestedPackageStamp)
	expect(granted.ref).toBe('{{secret:SIGNING_KEY|scope=user}}')
})

test('a stamped package secret mount checks the loaded secret name', async () => {
	const stamp = vi
		.spyOn(stampPresence, 'packageCarriesCredentialStamp')
		.mockResolvedValue(true)
	const needs = vi
		.spyOn(needsClosure, 'loadPublishedCredentialNeeds')
		.mockResolvedValue([
			{
				key: 'ALIAS',
				provider: 'aws',
				description: 'alias only',
				multiple: false,
			},
		])
	try {
		const undeclared = await settle(
			(await setup()).resolve('SIGNING_KEY', attestedPackageStamp),
		)
		expect(undeclared.ok).toBe(false)
		if (!undeclared.ok) {
			expect(undeclared.error).toMatchObject({
				code: 'credential_need_undeclared',
				key: 'SIGNING_KEY',
			})
		}
		needs.mockResolvedValue([
			{
				key: 'SIGNING_KEY',
				kind: 'signing',
				provider: 'aws',
				description: 'Signing key.',
				multiple: false,
			},
		])
		const declared = await settle(
			(await setup()).resolve('SIGNING_KEY', attestedPackageStamp),
		)
		expect(declared.ok).toBe(true)
	} finally {
		stamp.mockRestore()
		needs.mockRestore()
	}
})

test('packageSecrets.has answers from metadata when ciphertext cannot decrypt', async () => {
	const t = await setup()
	await t.env.APP_DB.prepare(
		`UPDATE secret_entries SET encrypted_value = 'v2.not-valid.ciphertext' WHERE name = 'SIGNING_KEY'`,
	).run()
	await expect(t.resolve('SIGNING_KEY', attestedPackageStamp)).rejects.toThrow(
		'Unable to decrypt secret value.',
	)
	await expect(
		t.resolve('SIGNING_KEY', attestedPackageStamp, 'presence'),
	).resolves.toMatchObject({
		alias: 'SIGNING_KEY',
		name: 'SIGNING_KEY',
		ref: '{{secret:SIGNING_KEY|scope=user}}',
		scope: 'user',
	})
	const tools = await createCapabilityProxyPackageHostTools({
		env: t.env,
		callerContext: t.callerContext,
	})
	if (!tools.packageSecretHas) throw new Error('packageSecretHas missing')
	await expect(
		tools.packageSecretHas({
			alias: 'SIGNING_KEY',
			packageId: t.packageBinding,
		}),
	).resolves.toEqual({ has: true })
})

test('the local-execute capability proxy returns only opaque refs to package code', async () => {
	const t = await setup()
	const tools = await createCapabilityProxyPackageHostTools({
		env: t.env,
		callerContext: t.callerContext,
	})
	if (!tools.packageSecretGet) throw new Error('packageSecretGet missing')
	const get = tools.packageSecretGet
	await expect(
		get({ alias: 'HOSTED_KEY', packageId: t.packageBinding }),
	).resolves.toEqual({ value: '{{secret:HOSTED_KEY|scope=user}}' })
	for (const alias of aliases) {
		const outcome = await settle(get({ alias, packageId: t.packageBinding }))
		expectNoPlaintext(outcome.ok ? outcome.result : outcome.error)
	}
})

test('a manifest cannot declare a slot that reads the raw value', () => {
	for (const kind of ['secret', 'oauth', 'mcp']) {
		const content = manifestJson({
			KEY: {
				kind,
				provider: 'aws',
				description: 'Key.',
				raw: true,
			},
		})
		expect(() =>
			parseAuthoredPackageJson({ content, mode: 'authoring' }),
		).toThrow(/raw/)
		// Snapshots published with a raw slot load it as invalid, never usable.
		const published = parseAuthoredPackageJson({
			content,
			mode: 'published',
		}).kody
		expect(published.credentials).toEqual({})
		expect(published.invalidCredentialSlots?.KEY).toMatch(/raw/)
	}
})
