import { expect, test, vi } from 'vitest'
import { readDeclaredPackageSecretFillPlacement } from './package-manifest-fill-placement.ts'

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: vi.fn(),
}))
vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: vi.fn(),
}))

const { getSavedPackageById } = await import('#worker/package-registry/repo.ts')
const { loadPackageManifestBySourceId } =
	await import('#worker/package-registry/source.ts')

const getSavedPackageByIdMock = vi.mocked(getSavedPackageById)
const loadPackageManifestBySourceIdMock = vi.mocked(
	loadPackageManifestBySourceId,
)

test('readDeclaredPackageSecretFillPlacement returns declared body placement', async () => {
	getSavedPackageByIdMock.mockResolvedValueOnce({
		id: 'pkg-1',
		sourceId: 'src-1',
	} as Awaited<ReturnType<typeof getSavedPackageById>>)
	loadPackageManifestBySourceIdMock.mockResolvedValueOnce({
		manifest: {
			kody: {
				credentials: {
					'audible-refresh-token': {
						kind: 'secret',
						description: 'Refresh token for Amazon /auth/token.',
						placement: { body: true },
					},
				},
			},
		},
	} as unknown as Awaited<ReturnType<typeof loadPackageManifestBySourceId>>)

	await expect(
		readDeclaredPackageSecretFillPlacement({
			env: { APP_DB: {} } as Env,
			userId: 'user-1' as never,
			baseUrl: 'https://kody.example',
			packageId: 'pkg-1',
			secretName: 'audible-refresh-token',
		}),
	).resolves.toEqual({ body: true })
})

test('readDeclaredPackageSecretFillPlacement returns undefined when undeclared', async () => {
	getSavedPackageByIdMock.mockResolvedValueOnce({
		id: 'pkg-1',
		sourceId: 'src-1',
	} as Awaited<ReturnType<typeof getSavedPackageById>>)
	loadPackageManifestBySourceIdMock.mockResolvedValueOnce({
		manifest: {
			kody: {
				credentials: {
					'audible-refresh-token': {
						kind: 'secret',
						description: 'Refresh token for Amazon /auth/token.',
					},
				},
			},
		},
	} as unknown as Awaited<ReturnType<typeof loadPackageManifestBySourceId>>)

	await expect(
		readDeclaredPackageSecretFillPlacement({
			env: { APP_DB: {} } as Env,
			userId: 'user-1' as never,
			baseUrl: 'https://kody.example',
			packageId: 'pkg-1',
			secretName: 'audible-refresh-token',
		}),
	).resolves.toBeUndefined()
})

test('readDeclaredPackageSecretFillPlacement swallows load failures', async () => {
	getSavedPackageByIdMock.mockRejectedValueOnce(new Error('db down'))
	await expect(
		readDeclaredPackageSecretFillPlacement({
			env: { APP_DB: {} } as Env,
			userId: 'user-1' as never,
			baseUrl: 'https://kody.example',
			packageId: 'pkg-1',
			secretName: 'audible-refresh-token',
		}),
	).resolves.toBeUndefined()
})
