import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createProfile, revokeProfile, type ProfilesCaller } from './service.ts'
import { resolveProfileTokenTarget } from './tokens.ts'

vi.mock('./flag.ts', () => ({ isProfilesEnabledFor: async () => true }))

function setup() {
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: false,
	})
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const callerFor = (input: { userId?: string; profileId?: string | null }) =>
		({
			env: { APP_DB: db },
			orgId: 'org_acme',
			actor: {
				userId: input.userId ?? 'user_kent',
				profileId: input.profileId ?? null,
				isOwner: false,
			},
			holds: () => true,
		}) as unknown as ProfilesCaller
	const requestFor = (input: { userId?: string; profileId?: string | null }) =>
		({
			org: { id: 'org_acme' },
			actor: { userId: input.userId ?? 'user_kent' },
			credential: { profileId: input.profileId ?? null },
		}) as unknown as RequestContext
	return { db, callerFor, requestFor }
}

async function chainOfThree() {
	const ctx = setup()
	const root = await createProfile(ctx.callerFor({}), {
		name: 'root',
		expiresAt: '2099-01-01T00:00:00.000Z',
	})
	const child = await createProfile(ctx.callerFor({ profileId: root.id }), {
		name: 'child',
		parentProfileId: root.id,
		expiresAt: '2098-01-01T00:00:00.000Z',
	})
	const grandchild = await createProfile(
		ctx.callerFor({ profileId: child.id }),
		{ name: 'grandchild', parentProfileId: child.id },
	)
	return { ...ctx, root, child, grandchild }
}

test('a person mints for their own profile, capped by the chain expiry', async () => {
	const { db, requestFor, grandchild } = await chainOfThree()
	const target = await resolveProfileTokenTarget({
		db,
		request: requestFor({}),
		profileId: grandchild.id,
	})
	expect(target.chain.map((row) => row.name)).toEqual([
		'root',
		'child',
		'grandchild',
	])
	expect(target.maxExpiresAt).toBe('2098-01-01T00:00:00.000Z')
})

test('a profile mints for itself or a sub-profile, never a parent', async () => {
	const { db, requestFor, root, child, grandchild } = await chainOfThree()
	const asChild = requestFor({ profileId: child.id })
	await expect(
		resolveProfileTokenTarget({ db, request: asChild, profileId: child.id }),
	).resolves.toMatchObject({ maxExpiresAt: '2098-01-01T00:00:00.000Z' })
	await expect(
		resolveProfileTokenTarget({
			db,
			request: asChild,
			profileId: grandchild.id,
		}),
	).resolves.toBeTruthy()
	await expect(
		resolveProfileTokenTarget({ db, request: asChild, profileId: root.id }),
	).rejects.toMatchObject({ status: 403 })
})

test("another person's profile is not found", async () => {
	const { db, requestFor, child } = await chainOfThree()
	await expect(
		resolveProfileTokenTarget({
			db,
			request: requestFor({ userId: 'user_other' }),
			profileId: child.id,
		}),
	).rejects.toMatchObject({ status: 404 })
})

test('a revoked parent stops tokens for every sub-profile', async () => {
	const { db, callerFor, requestFor, root, grandchild } = await chainOfThree()
	await revokeProfile(callerFor({}), { profileId: root.id })
	await expect(
		resolveProfileTokenTarget({
			db,
			request: requestFor({}),
			profileId: grandchild.id,
		}),
	).rejects.toMatchObject({ status: 409 })
})
