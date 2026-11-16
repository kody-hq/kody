import { expect, test, vi } from 'vitest'

const stored = vi.hoisted(() => ({
	bundles: [] as Array<string>,
	credentials: [] as Array<{
		id: string
		name: string
		owner_id: string
		allowed_packages: string
	}>,
	mappings: [] as Array<{ credential_ids_json: string }>,
}))

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	hasPublishedRuntimeArtifacts: () => true,
	loadPublishedSourceSnapshot: async () => null,
	readPublishedBundleArtifact: async ({ kvKey }: { kvKey: string }) => ({
		kind: 'module',
		modules: { 'bundle.js': stored.bundles[Number(kvKey)] },
	}),
}))
vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageByIdInAnyOrg: async (_db: unknown, id: string) =>
		id === 'package'
			? { id, userId: 'package-owner', sourceId: 'source' }
			: null,
}))

const { countCredentialReferences, runListedPackageCredentialUseDetail } =
	await import('./listed-package-credential-use-detail.ts')

function makeEnv() {
	return {
		APP_DB: {
			prepare: (sql: string) => ({
				bind: (...args: Array<unknown>) => ({
					all: async () => {
						if (sql.includes('secret_entries')) {
							return { results: stored.credentials }
						}
						if (sql.includes('credential_mappings')) {
							return { results: stored.mappings }
						}
						const [, , limit, offset] = args as [string, string, number, number]
						return {
							results: stored.bundles
								.map((_, index) => ({
									kv_key: String(index),
									artifact_kind: 'module',
								}))
								.slice(offset, offset + limit),
						}
					},
				}),
			}),
		},
	} as unknown as Env
}

const directRead = `export const a = () => globalThis.fetch(url)`

test('counts references to a listed credential only in bundles that read fetch through the global object', async () => {
	stored.credentials = [
		{
			id: 'locked',
			name: 'apiKey',
			owner_id: 'someone-else',
			allowed_packages: JSON.stringify(['package', 'other']),
		},
		{
			id: 'near-miss',
			name: 'unrelated',
			owner_id: 'package-owner',
			allowed_packages: JSON.stringify(['package-2']),
		},
	]
	stored.mappings = [
		{ credential_ids_json: JSON.stringify(['locked']) },
		{ credential_ids_json: JSON.stringify(['another']) },
	]
	stored.bundles = [
		`${directRead}\nconst h = { a: 'Bearer {{secret:apiKey}}', b: '{{secret:other}}' }`,
		`${directRead}\nconst c = credential('need'); const k = __kodySecretRef("apiKey", null)`,
		`export const a = () => fetch(url, '{{secret:apiKey}}')`,
	]
	expect(
		await runListedPackageCredentialUseDetail({
			env: makeEnv(),
			packageId: 'package',
		}),
	).toEqual({
		packageId: 'package',
		found: true,
		credentials: [
			{ credentialId: 'locked', ownerIsPackageOwner: false, mappedNeeds: 1 },
		],
		bundles: 3,
		bundlesWithDirectRead: 2,
		directReadBundles: {
			withLockedCredentialPlaceholder: 2,
			lockedCredentialPlaceholders: 2,
			withAnyPlaceholder: 2,
			anyPlaceholders: 3,
			withCredentialClientCall: 1,
			credentialClientCalls: 1,
		},
		nextOffset: null,
	})
})

test('pages through the bundles of a package', async () => {
	stored.credentials = []
	stored.mappings = []
	stored.bundles = [directRead, directRead, directRead]
	const first = await runListedPackageCredentialUseDetail({
		env: makeEnv(),
		packageId: 'package',
		bundlesPerCall: 2,
	})
	expect([first.bundles, first.nextOffset]).toEqual([2, 2])
	const second = await runListedPackageCredentialUseDetail({
		env: makeEnv(),
		packageId: 'package',
		bundlesPerCall: 2,
		offset: 2,
	})
	expect([second.bundles, second.nextOffset]).toEqual([1, null])
})

test('an unknown package reports nothing', async () => {
	const detail = await runListedPackageCredentialUseDetail({
		env: makeEnv(),
		packageId: 'missing',
	})
	expect([detail.found, detail.bundles, detail.credentials]).toEqual([
		false,
		0,
		[],
	])
})

test('a property or longer name is not a credential client call', async () => {
	expect(
		countCredentialReferences(
			{
				'bundle.js': `options.credential(x); loadCredentials(y); credential(z)`,
			},
			new Set(),
		).clientCalls,
	).toBe(1)
})
