import { expect, test, vi } from 'vitest'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import {
	collaboratorCapabilityContext,
	collaboratorPeople,
	type CollaboratorPerson,
	insertCollaboratorGrant,
	type PackageCollaboratorsSeed,
	seedPackageCollaborators,
} from '#worker/test-support/package-collaborators-seed.ts'

vi.unmock('#worker/audit-log.ts')

const mocks = vi.hoisted(() => ({
	resolveSavedPackage: vi.fn(),
	loadInvokeManifestBySourceId: vi.fn(),
	loadPublishedCredentialNeeds: vi.fn(),
}))

vi.mock('#worker/credentials/credential-needs-closure.ts', () => ({
	loadPublishedCredentialNeeds: (...args: Array<unknown>) =>
		mocks.loadPublishedCredentialNeeds(...args),
}))

vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackage: (...args: Array<unknown>) =>
		mocks.resolveSavedPackage(...args),
	loadInvokeManifestBySourceId: (...args: Array<unknown>) =>
		mocks.loadInvokeManifestBySourceId(...args),
}))

const {
	packageAppConnectedPeopleListCapability,
	packageAppConnectedPersonRevokeCapability,
} = await import('./package-app-connected-people.ts')

async function createSeed(): Promise<PackageCollaboratorsSeed> {
	const seed = await seedPackageCollaborators()
	await ensureUsersTestSchema({ db: seed.db, columns: ['profile_visibility'] })
	seed.sqlite.exec(`
		CREATE TABLE IF NOT EXISTS package_app_oauth_grants (
			id TEXT PRIMARY KEY NOT NULL,
			person_id TEXT NOT NULL,
			org_username TEXT NOT NULL,
			kody_id TEXT NOT NULL,
			scopes TEXT NOT NULL,
			created_at TEXT NOT NULL,
			revoked_at TEXT,
			last_used_at TEXT
		);
		CREATE TABLE IF NOT EXISTS package_app_grant_credential_mappings (
			grant_id TEXT NOT NULL,
			need_key TEXT NOT NULL,
			credential_ids_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (grant_id, need_key)
		);
	`)
	mocks.resolveSavedPackage.mockReset()
	mocks.resolveSavedPackage.mockImplementation(
		async (input: { userId: string; packageIdOrKodyId: string }) => {
			const savedPackage = seed.savedPackages.find(
				(candidate) =>
					candidate.userId === input.userId &&
					(candidate.id === input.packageIdOrKodyId ||
						candidate.kodyId === input.packageIdOrKodyId),
			)
			return savedPackage
				? {
						...savedPackage,
						sourceId: `source-${savedPackage.id}`,
						hasApp: savedPackage.id === 'pkg-1',
					}
				: null
		},
	)
	mocks.loadInvokeManifestBySourceId.mockReset()
	mocks.loadInvokeManifestBySourceId.mockResolvedValue({
		manifest: {
			kody: {
				app: {
					visitorNeeds: {
						calendar: { description: 'Read your calendar' },
					},
				},
			},
		},
	})
	mocks.loadPublishedCredentialNeeds.mockReset()
	mocks.loadPublishedCredentialNeeds.mockResolvedValue([
		{
			key: 'payroll',
			supplier: 'executor',
			description: 'Run payroll with your account',
		},
	])
	return seed
}

function insertAppGrant(
	seed: PackageCollaboratorsSeed,
	input: {
		id: string
		person: CollaboratorPerson
		kodyId?: string
		scopes?: Array<string>
		createdAt: string
		lastUsedAt?: string | null
		revokedAt?: string | null
	},
) {
	seed.sqlite
		.prepare(
			`INSERT INTO package_app_oauth_grants
			 (id, person_id, org_username, kody_id, scopes, created_at, revoked_at, last_used_at)
			 VALUES (?, ?, 'zeta-co', ?, ?, ?, ?, ?)`,
		)
		.run(
			input.id,
			collaboratorPeople[input.person].personId,
			input.kodyId ?? 'demo-package',
			(input.scopes ?? ['profile']).join(' '),
			input.createdAt,
			input.revokedAt ?? null,
			input.lastUsedAt ?? null,
		)
}

function liveGrantIds(seed: PackageCollaboratorsSeed) {
	return seed.sqlite
		.prepare(
			`SELECT id FROM package_app_oauth_grants WHERE revoked_at IS NULL ORDER BY id`,
		)
		.all()
		.map((row) => row.id)
}

function seedConnectedPeople(seed: PackageCollaboratorsSeed) {
	insertAppGrant(seed, {
		id: 'g-bob',
		person: 'bob',
		scopes: [
			'profile',
			'email',
			'need:calendar',
			'need:payroll',
			'need:unknown-key',
		],
		createdAt: '2026-01-01T00:00:00.000Z',
		lastUsedAt: '2026-01-05T00:00:00.000Z',
	})
	insertAppGrant(seed, {
		id: 'g-dan',
		person: 'dan',
		createdAt: '2026-01-02T00:00:00.000Z',
		lastUsedAt: '2026-01-09T00:00:00.000Z',
	})
	insertAppGrant(seed, {
		id: 'g-erin',
		person: 'erin',
		createdAt: '2026-01-03T00:00:00.000Z',
		lastUsedAt: null,
	})
	// Revoked, another app, and a deleted account never show.
	insertAppGrant(seed, {
		id: 'g-ada-revoked',
		person: 'ada',
		createdAt: '2026-01-04T00:00:00.000Z',
		revokedAt: '2026-01-04T01:00:00.000Z',
	})
	insertAppGrant(seed, {
		id: 'g-dan-other',
		person: 'dan',
		kodyId: 'other-package',
		createdAt: '2026-01-04T00:00:00.000Z',
	})
	seed.sqlite.exec(
		`INSERT INTO users (id, username, email, password_hash, stable_user_id, deleted_at)
		 VALUES (99, 'gone', 'gone@example.com', 'x', '${'f'.repeat(64)}', '2026-01-06T00:00:00.000Z')`,
	)
	seed.sqlite.exec(
		`INSERT INTO package_app_oauth_grants
		 (id, person_id, org_username, kody_id, scopes, created_at, last_used_at)
		 VALUES ('g-gone', '${'f'.repeat(64)}', 'zeta-co', 'demo-package', 'profile', '2026-01-01T00:00:00.000Z', '2026-01-10T00:00:00.000Z')`,
	)
	seed.sqlite.exec(
		`UPDATE users SET profile_visibility = 'private' WHERE username = 'dan'`,
	)
}

test('lists live people for the app by last used, paginated, with plain-language approvals', async () => {
	const seed = await createSeed()
	seedConnectedPeople(seed)
	const ctx = collaboratorCapabilityContext(seed, 'ada', 'owner')
	const first = await packageAppConnectedPeopleListCapability.handler(
		{ package_id: 'demo-package', page_size: 2 },
		ctx,
	)
	expect(first.package).toEqual({
		id: 'pkg-1',
		kody_id: 'demo-package',
		name: 'demo-package',
	})
	expect(first.total).toBe(3)
	expect(first.page).toBe(1)
	expect(first.people.map((person) => person.grant_id)).toEqual([
		'g-dan',
		'g-bob',
	])
	const [dan, bob] = first.people
	expect(dan).toMatchObject({
		username: 'dan',
		display_name: null,
		profile_path: null,
		last_used_at: '2026-01-09T00:00:00.000Z',
	})
	expect(bob).toMatchObject({
		username: 'bob',
		display_name: 'Bob Builder',
		profile_path: '/@bob',
		connected_at: '2026-01-01T00:00:00.000Z',
		allows: [
			'See their name, username, and avatar',
			'See their email address',
			'Use their own data or credentials: Read your calendar',
			'Use their own data or credentials: Run payroll with your account',
			'Use their own data or credentials for this app',
		],
	})
	expect(JSON.stringify(first)).not.toMatch(/need:|unknown-key|payroll"/)

	const second = await packageAppConnectedPeopleListCapability.handler(
		{ package_id: 'demo-package', page: 2, page_size: 2 },
		ctx,
	)
	expect(second.total).toBe(3)
	expect(second.people.map((person) => person.grant_id)).toEqual(['g-erin'])
	expect(second.people[0]!.last_used_at).toBeNull()
})

test('people without Manage on the package cannot list or revoke', async () => {
	const seed = await createSeed()
	seedConnectedPeople(seed)
	insertCollaboratorGrant(seed, {
		id: 'grant-dan-use',
		packageId: 'pkg-1',
		subjectType: 'user',
		subjectId: collaboratorPeople.dan.personId,
		preset: 'use',
	})
	for (const ctx of [
		collaboratorCapabilityContext(seed, 'bob', 'member'),
		collaboratorCapabilityContext(seed, 'dan', null),
		collaboratorCapabilityContext(seed, 'erin', null),
	]) {
		await expect(
			packageAppConnectedPeopleListCapability.handler(
				{ package_id: 'demo-package' },
				ctx,
			),
		).rejects.toThrow(/Manage on this package|not found/)
		await expect(
			packageAppConnectedPersonRevokeCapability.handler(
				{ package_id: 'demo-package', grant_id: 'g-bob' },
				ctx,
			),
		).rejects.toThrow(/Manage on this package|not found/)
	}
	expect(liveGrantIds(seed)).toContain('g-bob')
})

test('a Manage collaborator can list', async () => {
	const seed = await createSeed()
	seedConnectedPeople(seed)
	insertCollaboratorGrant(seed, {
		id: 'grant-dan-manage',
		packageId: 'pkg-1',
		subjectType: 'user',
		subjectId: collaboratorPeople.dan.personId,
		preset: 'manage',
	})
	const result = await packageAppConnectedPeopleListCapability.handler(
		{ package_id: 'demo-package' },
		collaboratorCapabilityContext(seed, 'dan', null),
	)
	expect(result.total).toBe(3)
})

test('a package without an app has no connected people', async () => {
	const seed = await createSeed()
	await expect(
		packageAppConnectedPeopleListCapability.handler(
			{ package_id: 'other-package' },
			collaboratorCapabilityContext(seed, 'ada', 'owner'),
		),
	).rejects.toThrow(/no app/)
})

test('owner revoke ends the grant, keeps the visitor credentials, and is audited', async () => {
	const seed = await createSeed()
	seedConnectedPeople(seed)
	seed.sqlite.exec(
		`INSERT INTO package_app_grant_credential_mappings
		 (grant_id, need_key, credential_ids_json, created_at, updated_at)
		 VALUES ('g-bob', 'calendar', '["cred-bob"]', 'now', 'now');
		 INSERT INTO credential_mappings
		 (id, org_id, package_id, need_key, target, person_user_id, credential_ids_json, created_at, updated_at)
		 VALUES ('map-bob', 'org-bob', 'bob-package', 'calendar', 'mine', '${collaboratorPeople.bob.personId}', '["cred-bob"]', 'now', 'now');`,
	)
	const ctx = collaboratorCapabilityContext(seed, 'ada', 'owner')
	await expect(
		packageAppConnectedPersonRevokeCapability.handler(
			{ package_id: 'demo-package', grant_id: 'g-dan-other' },
			ctx,
		),
	).rejects.toThrow(/no longer signed in/)
	const result = await packageAppConnectedPersonRevokeCapability.handler(
		{ package_id: 'demo-package', grant_id: 'g-bob' },
		ctx,
	)
	expect(result).toEqual({ grant_id: 'g-bob', revoked: true })
	expect(liveGrantIds(seed)).not.toContain('g-bob')
	const listed = await packageAppConnectedPeopleListCapability.handler(
		{ package_id: 'demo-package' },
		ctx,
	)
	expect(listed.total).toBe(2)
	expect(listed.people.map((person) => person.grant_id)).not.toContain('g-bob')
	expect(
		seed.sqlite
			.prepare(`SELECT grant_id FROM package_app_grant_credential_mappings`)
			.all(),
	).toEqual([])
	expect(
		seed.sqlite
			.prepare(`SELECT id, credential_ids_json FROM credential_mappings`)
			.all(),
	).toEqual([{ id: 'map-bob', credential_ids_json: '["cred-bob"]' }])
	await expect(
		packageAppConnectedPersonRevokeCapability.handler(
			{ package_id: 'demo-package', grant_id: 'g-bob' },
			ctx,
		),
	).rejects.toThrow(/no longer signed in/)
	const audit = await seed.auditDb
		.prepare(
			`SELECT action, email_hash IS NOT NULL AS has_email, client_id, reason FROM audit_events WHERE action = 'package_app_grant_owner_revoke'`,
		)
		.all()
	expect(audit.results).toEqual([
		{
			action: 'package_app_grant_owner_revoke',
			has_email: 1,
			client_id: 'zeta-co/demo-package',
			reason: 'grant:g-bob',
		},
	])
})
