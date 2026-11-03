import { expect, test } from 'vitest'
import {
	diffSnapshots,
	findPackagesListedByMoreThanOneOwner,
	stripVolatile,
	takeJsonSnapshot,
	type SnapshotUser,
} from './json-snapshot.ts'
import type { OpenRehearsalSession, RehearsalSession } from './kody-session.ts'
import { appMarker } from './rehearsal-packages.ts'

test('stripVolatile drops per-read fields but keeps job schedules', () => {
	expect(
		stripVolatile({
			jobs: [
				{ id: 'j1', next_run_at: '2026-10-09T00:00:00Z', last_run_at: 'x' },
			],
			updated_at: 'x',
			serverTiming: [{ name: 'a', durationMs: 1 }],
			matches: [{ id: 'm1', mutation_guidance: 'x' }],
		}),
	).toEqual({
		jobs: [{ id: 'j1', next_run_at: '2026-10-09T00:00:00Z' }],
		matches: [{ id: 'm1' }],
	})
})

test('diffSnapshots reports changed, added, and removed paths, ignoring takenAt and observed', () => {
	const before = {
		takenAt: 'a',
		people: [
			{
				role: 'alice',
				tokens: [{ id: 't1' }],
				proofs: { user: 'h1' },
				observed: { usage: { executes: 3 } },
			},
		],
	}
	const after = {
		takenAt: 'b',
		people: [
			{
				role: 'alice',
				tokens: [{ id: 't1' }, { id: 't2' }],
				proofs: { user: 'h2' },
				observed: { usage: { executes: 9 } },
			},
		],
	}
	expect(diffSnapshots(before, after)).toEqual([
		{ path: '.people.alice.proofs.user', before: 'h1', after: 'h2' },
		{ path: '.people.alice.tokens.t2', before: undefined, after: { id: 't2' } },
	])
})

test('diffSnapshots keys D1 databases by role and tables by name', () => {
	const before = {
		databases: [
			{
				role: 'app',
				tables: [
					{ table: 'users', rows: 2 },
					{ table: 'z_late', rows: 1 },
				],
			},
		],
	}
	const after = {
		databases: [
			{
				role: 'app',
				tables: [
					{ table: 'credential_inventory_items', rows: 0 },
					{ table: 'users', rows: 2 },
					{ table: 'z_late', rows: 3 },
				],
			},
		],
	}
	expect(diffSnapshots(before, after)).toEqual([
		{
			path: '.databases.app.tables.credential_inventory_items',
			before: undefined,
			after: { table: 'credential_inventory_items', rows: 0 },
		},
		{ path: '.databases.app.tables.z_late.rows', before: 1, after: 3 },
	])
})

test('diffSnapshots keeps keyed identities named observed and __proto__', () => {
	expect(
		diffSnapshots(
			{
				databases: [{ role: 'app', tables: [{ table: 'observed', rows: 1 }] }],
			},
			{
				databases: [{ role: 'app', tables: [{ table: 'observed', rows: 2 }] }],
			},
		),
	).toEqual([
		{ path: '.databases.app.tables.observed.rows', before: 1, after: 2 },
	])
	expect(
		diffSnapshots(
			{ databases: [{ role: 'app', tables: [] }] },
			{
				databases: [{ role: 'app', tables: [{ table: '__proto__', rows: 1 }] }],
			},
		),
	).toEqual([
		{
			path: '.databases.app.tables.__proto__',
			before: undefined,
			after: { table: '__proto__', rows: 1 },
		},
	])
})

test('findPackagesListedByMoreThanOneOwner flags a package injected into another org', () => {
	expect(
		findPackagesListedByMoreThanOneOwner({
			alice: { packages: [{ id: 'a1' }, { id: 'shared' }] },
			carol: { packages: [{ id: 'c1' }, { id: 'shared' }] },
			'@rh-platform': { packages: [{ id: 'o1' }] },
			dave: { error: 'failed' },
		}),
	).toEqual([{ id: 'shared', owners: ['alice', 'carol'] }])
	expect(
		findPackagesListedByMoreThanOneOwner({
			alice: { packages: [{ id: 'a1' }] },
			'@rh-platform': { packages: [{ id: 'o1' }] },
		}),
	).toEqual([])
})

function snapshotUser(
	role: SnapshotUser['role'],
	orgSlug = `rh-${role}`,
): SnapshotUser {
	return {
		role,
		email: `rh-${role}@example.com`,
		username: `rh-${role}`,
		orgSlug,
		password: 'secret',
	}
}

function fakeSession(cookieHeader: string): RehearsalSession {
	return {
		email: 'unused@example.com',
		cookieHeader,
		execute: async () => ({
			sha256: 'secret-hash',
			authorizationSha256: 'auth-hash',
		}),
		api: async () => ({}),
		request: async () => ({ status: 200, body: appMarker, location: null }),
		close: async () => {},
	}
}

test('takeJsonSnapshot reuses person cookies and does not re-login alice', async () => {
	const opens: Array<{
		email: string
		orgSlug?: string
		cookieHeader?: string
	}> = []
	const openSession: OpenRehearsalSession = async (
		_origin,
		credentials,
		options = {},
	) => {
		opens.push({
			email: credentials.email,
			orgSlug: options.orgSlug,
			cookieHeader: options.cookieHeader,
		})
		return fakeSession(
			options.cookieHeader ?? `kody_session=${credentials.email}`,
		)
	}
	const snapshot = await takeJsonSnapshot({
		origins: {
			app: 'https://app.example',
			api: 'https://api.example',
			mockCloudflare: 'https://mock.example',
		},
		users: [
			snapshotUser('admin'),
			snapshotUser('alice'),
			snapshotUser('bob'),
			snapshotUser('carol'),
			snapshotUser('dave'),
		],
		now: () => new Date('2026-10-12T00:00:00.000Z'),
		openSession,
	})
	expect(opens).toEqual([
		{ email: 'rh-admin@example.com', orgSlug: 'rh-admin' },
		{ email: 'rh-alice@example.com', orgSlug: 'rh-alice' },
		{ email: 'rh-bob@example.com', orgSlug: 'rh-bob' },
		{ email: 'rh-carol@example.com', orgSlug: 'rh-carol' },
		{ email: 'rh-dave@example.com', orgSlug: 'rh-dave' },
		{
			email: 'rh-bob@example.com',
			orgSlug: 'rh-platform',
			cookieHeader: 'kody_session=rh-bob@example.com',
		},
		{
			email: 'rh-carol@example.com',
			orgSlug: 'rh-alice',
			cookieHeader: 'kody_session=rh-carol@example.com',
		},
	])
	expect(
		opens.filter((open) => open.email === 'rh-alice@example.com'),
	).toHaveLength(1)
	expect(snapshot.failures).toEqual([])
	expect(snapshot.grantee).toMatchObject({ grantee: 'carol', org: 'rh-alice' })
})
