import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type Mock } from 'vitest'
import { type EntitySourceRow } from '#worker/repo/types.ts'

/**
 * Expands a `loadPackageManifestBySourceId` mock into the source exports
 * subscription discovery now calls after the KODY-BC prefetch (row batch +
 * `loadPackageManifestForSource`). Stub rows so unit tests keep driving
 * behavior through the existing manifest mock.
 */
export function createSubscriptionDiscoverySourceMocks(
	loadPackageManifestBySourceId: Mock,
) {
	return {
		loadPackageManifestBySourceId,
		loadPackageSourceRowsForUser: async (input: {
			userId: string
			sourceIds: ReadonlyArray<string>
		}) => {
			const byId = new Map<string, EntitySourceRow>()
			for (const sourceId of [...new Set(input.sourceIds)]) {
				byId.set(sourceId, {
					id: sourceId,
					user_id: input.userId as OwnerId,
					entity_kind: 'package',
					entity_id: `package-${sourceId}`,
					repo_id: `repo-${sourceId}`,
					published_commit: 'commit-1',
					indexed_commit: null,
					manifest_path: 'package.json',
					source_root: '/',
					last_external_check_at: null,
					external_check_until: null,
					created_at: '2026-01-01T00:00:00.000Z',
					updated_at: '2026-01-01T00:00:00.000Z',
				})
			}
			return byId
		},
		loadPackageManifestForSource: async (input: {
			env: unknown
			userId: string
			source: { id: string }
		}) =>
			await loadPackageManifestBySourceId({
				env: input.env,
				baseUrl: 'https://example.com',
				userId: input.userId,
				sourceId: input.source.id,
			}),
	}
}
