import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { encryptSecretValue, userSecretContext } from '#mcp/secrets/crypto.ts'
import { analyzeCredentialPathSegmentImpact } from './credential-path-segment-impact.ts'

const ownerId = ownerIdFromStored('user-impact-1')
const secretStoreKey = 'test-secret-store-key-32-chars-minimum!!'

function createDb(input: {
	runId: string
	complete: boolean
	items: Array<{
		packageId: string
		ownerId: string
		result: unknown
	}>
	secrets: Array<{
		id: string
		ownerId: string
		name: string
		value: string
	}>
	packages: Array<{
		id: string
		ownerId: string
		name: string
		kodyId: string
	}>
	users: Array<{ stableUserId: string; username: string }>
}) {
	return {
		prepare(query: string) {
			const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					return {
						async first() {
							if (normalized.includes('from credential_inventory_runs')) {
								return {
									id: input.runId,
									status: input.complete ? 'complete' : 'scanning',
									cursor: null,
								}
							}
							if (
								normalized.includes('from secret_entries') &&
								normalized.includes('e.id = ?')
							) {
								const owner = String(params[0])
								const id = String(params[1])
								const secret = input.secrets.find(
									(row) => row.id === id && row.ownerId === owner,
								)
								if (!secret) return null
								const encrypted = await encryptSecretValue(
									{ SECRET_STORE_KEY: secretStoreKey },
									secret.value,
									userSecretContext(ownerIdFromStored(secret.ownerId)),
								)
								return {
									id: secret.id,
									name: secret.name,
									kind: 'secret',
									encrypted_value: encrypted,
									allowed_hosts: '[]',
									inject_json: '{}',
									config_json: null,
									placement_json: null,
								}
							}
							return null
						},
						async all() {
							if (normalized.includes('from credential_inventory_items')) {
								if (normalized.includes("status = 'scanned'")) {
									return {
										results: input.items.map((item) => ({
											package_id: item.packageId,
											user_id: item.ownerId,
											status: 'scanned',
											result_json: JSON.stringify(item.result),
										})),
									}
								}
								return {
									results: input.items.map((item) => ({
										package_id: item.packageId,
										status: 'scanned',
										result_json: JSON.stringify(item.result),
									})),
								}
							}
							if (normalized.includes('from saved_packages')) {
								const ids = new Set(params.map(String))
								return {
									results: input.packages
										.filter((row) => ids.has(row.id))
										.map((row) => ({
											id: row.id,
											user_id: row.ownerId,
											name: row.name,
											kody_id: row.kodyId,
										})),
								}
							}
							if (normalized.includes('from users')) {
								const ids = new Set(params.map(String))
								return {
									results: input.users
										.filter((row) => ids.has(row.stableUserId))
										.map((row) => ({
											stable_user_id: row.stableUserId,
											username: row.username,
										})),
								}
							}
							return { results: [] }
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

test('analyzeCredentialPathSegmentImpact counts path fills whose values encode routing chars', async () => {
	const runId = 'run-path-impact'
	const env = {
		APP_DB: createDb({
			runId,
			complete: true,
			items: [
				{
					packageId: 'pkg-webhook',
					ownerId,
					result: {
						placeholders: {
							secret: 1,
							'secret-basic': 0,
							'integration-token': 0,
							vault: 0,
							computed: 0,
						},
						unparsedModules: 0,
						references: [
							{
								table: 'secret',
								credentialIds: ['cred-webhook'],
								scope: null,
								placement: { type: 'path' },
							},
						],
						slots: [],
					},
				},
				{
					packageId: 'pkg-plain',
					ownerId,
					result: {
						placeholders: {
							secret: 1,
							'secret-basic': 0,
							'integration-token': 0,
							vault: 0,
							computed: 0,
						},
						unparsedModules: 0,
						references: [
							{
								table: 'secret',
								credentialIds: ['cred-plain'],
								scope: null,
								placement: { type: 'path' },
							},
						],
						slots: [],
					},
				},
				{
					packageId: 'pkg-header',
					ownerId,
					result: {
						placeholders: {
							secret: 1,
							'secret-basic': 0,
							'integration-token': 0,
							vault: 0,
							computed: 0,
						},
						unparsedModules: 0,
						references: [
							{
								table: 'secret',
								credentialIds: ['cred-slash-header'],
								scope: null,
								placement: {
									type: 'header',
									name: 'x-api-key',
									format: '{value}',
								},
							},
						],
						slots: [],
					},
				},
			],
			secrets: [
				{
					id: 'cred-webhook',
					ownerId,
					name: 'webhookPath',
					value: 'T000/B000/xxx',
				},
				{
					id: 'cred-plain',
					ownerId,
					name: 'plainToken',
					value: 'one-segment-token',
				},
				{
					id: 'cred-slash-header',
					ownerId,
					name: 'slashHeader',
					value: 'a/b',
				},
			],
			packages: [
				{
					id: 'pkg-webhook',
					ownerId,
					name: '@demo/webhook-job',
					kodyId: 'webhook-job',
				},
				{
					id: 'pkg-plain',
					ownerId,
					name: '@demo/plain-path',
					kodyId: 'plain-path',
				},
			],
			users: [{ stableUserId: ownerId, username: 'demo' }],
		}),
		SECRET_STORE_KEY: secretStoreKey,
	}

	const report = await analyzeCredentialPathSegmentImpact({ env, runId })
	expect(report.pathReferences).toBe(2)
	expect(report.packagesWithPathPlacement).toBe(2)
	expect(report.packagesWithRoutingChars).toBe(1)
	expect(report.credentialsWithRoutingChars).toBe(1)
	expect(report.packages).toEqual([
		{
			packageId: 'pkg-webhook',
			ownerId,
			ownerHandle: 'demo',
			packageName: '@demo/webhook-job',
			kodyId: 'webhook-job',
			credentialNames: ['webhookPath'],
		},
	])
})

test('analyzeCredentialPathSegmentImpact refuses an incomplete inventory run', async () => {
	const env = {
		APP_DB: createDb({
			runId: 'run-incomplete',
			complete: false,
			items: [],
			secrets: [],
			packages: [],
			users: [],
		}),
		SECRET_STORE_KEY: secretStoreKey,
	}
	await expect(
		analyzeCredentialPathSegmentImpact({ env, runId: 'run-incomplete' }),
	).rejects.toThrow(/not complete/)
})
