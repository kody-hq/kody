import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { encryptSecretValue, userSecretContext } from '#mcp/secrets/crypto.ts'
import { analyzeCredentialPathSegmentImpact } from './credential-path-segment-impact.ts'

const ownerId = ownerIdFromStored('user-impact-1')
const otherOwnerId = ownerIdFromStored('user-impact-other')
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
								const id = String(params[0])
								const secret = input.secrets.find((row) => row.id === id)
								if (!secret) return null
								const encrypted = await encryptSecretValue(
									{ SECRET_STORE_KEY: secretStoreKey },
									secret.value,
									userSecretContext(ownerIdFromStored(secret.ownerId)),
								)
								return {
									id: secret.id,
									name: secret.name,
									encrypted_value: encrypted,
									user_id: secret.ownerId,
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
							if (
								normalized.includes('from users') &&
								normalized.includes('deleted_at is null')
							) {
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
	expect(report.undecryptableCredentials).toBe(0)
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

test('analyzeCredentialPathSegmentImpact counts other-org package Keys on path fills', async () => {
	const runId = 'run-other-org-key'
	const env = {
		APP_DB: createDb({
			runId,
			complete: true,
			items: [
				{
					packageId: 'pkg-shared',
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
								credentialIds: ['cred-other-org'],
								scope: 'package',
								placement: { type: 'path' },
							},
						],
						slots: [],
					},
				},
			],
			secrets: [
				{
					id: 'cred-other-org',
					ownerId: otherOwnerId,
					name: 'sharedWebhookPath',
					value: 'hooks/T000/B000/xxx',
				},
			],
			packages: [
				{
					id: 'pkg-shared',
					ownerId,
					name: '@demo/shared-webhook',
					kodyId: 'shared-webhook',
				},
			],
			users: [
				{ stableUserId: ownerId, username: 'publisher' },
				{ stableUserId: otherOwnerId, username: 'consumer' },
			],
		}),
		SECRET_STORE_KEY: secretStoreKey,
	}

	const report = await analyzeCredentialPathSegmentImpact({ env, runId })
	expect(report.packagesWithRoutingChars).toBe(1)
	expect(report.credentialsWithRoutingChars).toBe(1)
	expect(report.undecryptableCredentials).toBe(0)
	expect(report.packages).toEqual([
		{
			packageId: 'pkg-shared',
			ownerId,
			ownerHandle: 'publisher',
			packageName: '@demo/shared-webhook',
			kodyId: 'shared-webhook',
			credentialNames: ['sharedWebhookPath'],
		},
	])
})

test('analyzeCredentialPathSegmentImpact continues when a path Key will not decrypt', async () => {
	const runId = 'run-undecryptable'
	const env = {
		APP_DB: {
			prepare(query: string) {
				const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
				return {
					bind(...params: Array<unknown>) {
						return {
							async first() {
								if (normalized.includes('from credential_inventory_runs')) {
									return {
										id: runId,
										status: 'complete',
										cursor: null,
									}
								}
								if (
									normalized.includes('from secret_entries') &&
									normalized.includes('e.id = ?')
								) {
									return {
										id: String(params[0]),
										name: 'brokenPath',
										encrypted_value: 'v2.not-valid.ciphertext',
										user_id: ownerId,
									}
								}
								return null
							},
							async all() {
								if (
									normalized.includes('from credential_inventory_items') &&
									normalized.includes("status = 'scanned'")
								) {
									return {
										results: [
											{
												package_id: 'pkg-broken',
												user_id: ownerId,
												status: 'scanned',
												result_json: JSON.stringify({
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
															credentialIds: ['cred-broken'],
															scope: null,
															placement: { type: 'path' },
														},
													],
													slots: [],
												}),
											},
										],
									}
								}
								if (normalized.includes('from credential_inventory_items')) {
									return {
										results: [
											{
												package_id: 'pkg-broken',
												status: 'scanned',
												result_json: JSON.stringify({
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
															credentialIds: ['cred-broken'],
															scope: null,
															placement: { type: 'path' },
														},
													],
													slots: [],
												}),
											},
										],
									}
								}
								if (normalized.includes('from saved_packages')) {
									return { results: [] }
								}
								if (
									normalized.includes('from users') &&
									normalized.includes('deleted_at is null')
								) {
									return { results: [] }
								}
								return { results: [] }
							},
						}
					},
				}
			},
		} as unknown as D1Database,
		SECRET_STORE_KEY: secretStoreKey,
	}

	const report = await analyzeCredentialPathSegmentImpact({ env, runId })
	expect(report.packagesWithPathPlacement).toBe(1)
	expect(report.packagesWithRoutingChars).toBe(0)
	expect(report.undecryptableCredentials).toBe(1)
	expect(report.packages).toEqual([])
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
