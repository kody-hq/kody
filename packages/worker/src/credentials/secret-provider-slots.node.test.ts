import { expect, test, vi } from 'vitest'
import * as packageRepo from '#worker/package-registry/repo.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import * as publishedSource from '#worker/repo/published-source.ts'
import { resolveSecretProviderSlots } from './secret-provider-slots.ts'

function files(credentials: Record<string, unknown>) {
	return {
		'package.json': JSON.stringify({
			name: '@acme/deploy',
			kody: { description: 'Deploy.', credentials },
		}),
	}
}

const slot = (packageName: string) => ({
	kind: 'secret-provider',
	package: packageName,
	description: 'Reads the deploy token.',
})

test('resolveSecretProviderSlots reads each provider package id and fails closed', async () => {
	vi.spyOn(packageRepo, 'getSavedPackageByName').mockImplementation(
		async (_db, input) =>
			input.name === '@acme/missing'
				? null
				: ({
						id: `id-${input.name}`,
						userId: input.userId,
						sourceId: `source-${input.name}`,
						name: input.name,
					} as unknown as SavedPackageRecord),
	)
	vi.spyOn(publishedSource, 'loadPublishedEntityManifest').mockImplementation(
		async (input) => {
			if (input.sourceId === 'source-@acme/broken') {
				throw new Error('snapshot unavailable')
			}
			return {
				manifest: {
					kody:
						input.sourceId === 'source-@acme/op'
							? { secretProvider: { id: '1Password' } }
							: {},
				},
			} as unknown as Awaited<
				ReturnType<typeof publishedSource.loadPublishedEntityManifest>
			>
		},
	)
	const resolved = await resolveSecretProviderSlots({
		env: { APP_DB: {} } as Env,
		userId: 'org-acme',
		files: files({
			op: slot('@acme/op'),
			missing: slot('@acme/missing'),
			plain: slot('@acme/plain'),
			broken: slot('@acme/broken'),
			github: { description: 'Not a provider slot.' },
		}),
	})
	expect(resolved.ids).toEqual({ op: '1password' })
	expect(resolved.failures.map((failure) => failure.message)).toEqual([
		expect.stringContaining(
			'"@acme/missing", which is not a saved package in this org',
		),
		expect.stringContaining(
			'"@acme/plain", which does not declare kody.secretProvider.id',
		),
		expect.stringContaining(
			'"@acme/broken", which could not be read (snapshot unavailable)',
		),
	])
})
