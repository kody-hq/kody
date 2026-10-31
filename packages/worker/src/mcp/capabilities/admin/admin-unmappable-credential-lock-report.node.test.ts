import type * as UnmappableCredentialsModule from '#worker/credentials/package-unmappable-credentials.ts'
import { expect, test, vi } from 'vitest'
import {
	collaboratorPeople,
	insertCollaboratorGrant,
	seedPackageCollaborators,
} from '#worker/test-support/package-collaborators-seed.ts'

const mocks = vi.hoisted(() => ({
	byPackage: new Map<
		string,
		Array<{ needKey: string; credentialName: string | null; reason: string }>
	>(),
}))

vi.mock(
	'#worker/credentials/package-unmappable-credentials.ts',
	async (importOriginal) => ({
		...(await importOriginal<typeof UnmappableCredentialsModule>()),
		loadPackageUnmappableCredentials: async (input: {
			packageIds: ReadonlyArray<string>
		}) =>
			new Map(
				input.packageIds.flatMap((id) => {
					const credentials = mocks.byPackage.get(id)
					return credentials ? [[id, credentials] as const] : []
				}),
			),
	}),
)

const { scanUnmappableCredentialLockReportStep } =
	await import('./admin-unmappable-credential-lock-report.ts')

test('counts locked packages and collaborators without naming them', async () => {
	const seed = await seedPackageCollaborators()
	insertCollaboratorGrant(seed, {
		id: 'grant-bob-write',
		packageId: 'pkg-1',
		subjectType: 'user',
		subjectId: collaboratorPeople.bob.personId,
		preset: 'contribute',
	})
	insertCollaboratorGrant(seed, {
		id: 'grant-team-manage',
		packageId: 'pkg-1',
		subjectType: 'team',
		subjectId: 'team-design',
		preset: 'manage',
	})
	insertCollaboratorGrant(seed, {
		id: 'grant-team-allowed',
		packageId: 'pkg-2',
		subjectType: 'team',
		subjectId: 'team-design',
		preset: 'contribute',
	})
	insertCollaboratorGrant(seed, {
		id: 'grant-bob-use',
		packageId: 'pkg-2',
		subjectType: 'user',
		subjectId: collaboratorPeople.bob.personId,
		preset: 'use',
	})
	seed.sqlite
		.prepare(
			`UPDATE grants SET allow_unmappable_credential_changes = 1 WHERE id = ?`,
		)
		.run('grant-team-allowed')
	mocks.byPackage = new Map([
		[
			'pkg-1',
			[{ needKey: 'db', credentialName: 'Prod DB', reason: 'publisher' }],
		],
		[
			'pkg-2',
			[{ needKey: 'db', credentialName: 'Prod DB', reason: 'visitors' }],
		],
	])

	const state = {
		cursor: null,
		complete: false,
		counts: {
			packagesScanned: 0,
			packagesLocked: 0,
			grantsLocked: 0,
			collaboratorsLocked: 0,
			grantsAllowed: 0,
			packagesUnchecked: 0,
		},
	}
	await scanUnmappableCredentialLockReportStep({
		env: { APP_DB: seed.db } as Env,
		state,
		limit: 1,
	})
	expect(state).toMatchObject({ cursor: 'pkg-1', complete: false })
	await scanUnmappableCredentialLockReportStep({
		env: { APP_DB: seed.db } as Env,
		state,
		limit: 1,
	})
	expect(state).toEqual({
		cursor: 'pkg-2',
		complete: true,
		counts: {
			packagesScanned: 2,
			packagesLocked: 1,
			grantsLocked: 2,
			collaboratorsLocked: 2,
			grantsAllowed: 1,
			packagesUnchecked: 0,
		},
	})
	expect(JSON.stringify(state)).not.toContain('Prod DB')
})
