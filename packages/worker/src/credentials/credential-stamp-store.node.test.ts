import { expect, test, vi } from 'vitest'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import type { EntitySourceRow } from '#worker/repo/types.ts'
import { storePublishedCredentialStamp } from './credential-stamp-store.ts'

const mockModule = vi.hoisted(() => ({
	writePublishedCredentialStamp: vi.fn(async () => undefined),
	readPublishedCredentialStamp: vi.fn(async () => null),
	resolveSavedPackageImport: vi.fn(async () => null),
	getEntitySourceById: vi.fn(async () => null),
}))

vi.mock(
	'#worker/package-runtime/published-runtime-artifacts.ts',
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import('#worker/package-runtime/published-runtime-artifacts.ts')
			>()
		return {
			...actual,
			writePublishedCredentialStamp: mockModule.writePublishedCredentialStamp,
			readPublishedCredentialStamp: mockModule.readPublishedCredentialStamp,
		}
	},
)

vi.mock(
	'#worker/package-runtime/package-import-resolution.ts',
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import('#worker/package-runtime/package-import-resolution.ts')
			>()
		return {
			...actual,
			resolveSavedPackageImport: mockModule.resolveSavedPackageImport,
		}
	},
)

vi.mock('#worker/repo/entity-sources.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#worker/repo/entity-sources.ts')>()
	return {
		...actual,
		getEntitySourceById: mockModule.getEntitySourceById,
	}
})

function packageSource(
	overrides: Partial<EntitySourceRow> = {},
): EntitySourceRow {
	return {
		id: 'src-1',
		user_id: ownerIdFromStored('user-1'),
		repo_id: 'repo-1',
		entity_kind: 'package',
		entity_id: 'pkg-1',
		manifest_path: 'package.json',
		source_root: '',
		published_commit: 'commit-1',
		external_check_until: null,
		...overrides,
	} as EntitySourceRow
}

test('storePublishedCredentialStamp writes a sealed stamp with sorted keys', async () => {
	mockModule.writePublishedCredentialStamp.mockClear()
	const files = {
		'package.json': JSON.stringify({
			name: '@kody/demo',
			exports: { '.': './src/index.ts' },
			kody: {
				id: 'demo',
				description: 'Demo package for stamp store tests.',
				credentials: {
					API_KEY: { kind: 'secret', description: 'API key.' },
				},
			},
		}),
		'src/index.ts': [
			"import { credential } from 'kody:runtime'",
			'export default async function run() { return credential("API_KEY") }',
		].join('\n'),
	}
	const result = await storePublishedCredentialStamp({
		env: { APP_DB: {} } as Env,
		source: packageSource(),
		publishedCommit: 'commit-1',
		files,
	})
	expect(result).not.toBeNull()
	expect(result?.stamp.keys).toEqual(['API_KEY'])
	expect(result?.stamp.stampHash).toMatch(/^[0-9a-f]{64}$/)
	expect(result?.stamp.depStamps).toEqual([])
	expect(mockModule.writePublishedCredentialStamp).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'src-1',
			publishedCommit: 'commit-1',
			stamp: expect.objectContaining({ keys: ['API_KEY'] }),
		}),
	)
})

test('storePublishedCredentialStamp skips non-package sources', async () => {
	mockModule.writePublishedCredentialStamp.mockClear()
	const result = await storePublishedCredentialStamp({
		env: { APP_DB: {} } as Env,
		source: packageSource({ entity_kind: 'repo' }),
		publishedCommit: 'commit-1',
		files: { 'package.json': '{}' },
	})
	expect(result).toBeNull()
	expect(mockModule.writePublishedCredentialStamp).not.toHaveBeenCalled()
})
