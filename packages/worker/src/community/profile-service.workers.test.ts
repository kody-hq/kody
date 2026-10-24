import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	getCommunityPublicCacheVersion,
	invalidateCommunityPublicCache,
} from '#app/data-cache.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { buildPackageJobId } from '#worker/jobs/package-job-id.ts'
import { createJobStorageId } from '@kody-internal/shared/jobs/storage-id.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { ensureCommunityFlowSchema } from './community-flow-test-schema.ts'
import { insertCommunityActivityEvent } from './profile-repo.ts'
import {
	getCommunityProfileByUsername,
	getProfileActivity,
	listPublicProfilePackages,
	updateCommunityProfile,
} from './profile-service.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
const fixedNow = '2026-07-01T00:00:00.000Z'

type TestUser = Awaited<ReturnType<typeof insertUser>>

async function runSql(sql: string, ...values: Array<unknown>) {
	await env.APP_DB.prepare(sql)
		.bind(...values)
		.run()
}

async function insertUser(
	prefix: string,
	input: { visibility?: 'public' | 'private'; displayName?: string } = {},
) {
	await ensureCommunityFlowSchema(env.APP_DB)
	const email = `${prefix}-${crypto.randomUUID()}@example.com`
	const username = `${prefix}${crypto.randomUUID().slice(0, 8)}`
	const userId = testStableUserIdFromEmail(email)
	await runSql(
		`INSERT INTO users (
			username, email, stable_user_id, display_name, profile_visibility, password_hash
		) VALUES (?, ?, ?, ?, ?, ?)`,
		username,
		email,
		userId,
		input.displayName ?? null,
		input.visibility ?? 'public',
		'test-password-hash',
	)
	await provisionPersonalOrg(env.APP_DB, {
		stableUserId: userId,
		username,
		plan: 'max',
	})
	const row = await env.APP_DB.prepare(
		`SELECT id FROM users WHERE stable_user_id = ?`,
	)
		.bind(userId)
		.first<{ id: number }>()
	if (!row) throw new Error('Failed to insert test user')
	return { numericId: row.id, userId, username }
}

async function insertSavedPackage(
	owner: TestUser,
	kodyId: string,
	input: {
		description?: string
		tags?: Array<string>
		searchText?: string
		isPrivate?: boolean
		hidden?: boolean
		hasApp?: boolean
		updatedAt?: string
	} = {},
) {
	const id = `${kodyId}-${crypto.randomUUID()}`
	const updatedAt = input.updatedAt ?? fixedNow
	await runSql(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, hidden, is_private, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id,
		owner.userId,
		`@${owner.username}/${kodyId}`,
		kodyId,
		input.description ?? `${kodyId} description`,
		JSON.stringify(input.tags ?? ['catalog']),
		input.searchText ?? `${kodyId} search`,
		`source-${id}`,
		input.hasApp ? 1 : 0,
		input.hidden ? 1 : 0,
		input.isPrivate ? 1 : 0,
		updatedAt,
		updatedAt,
	)
	return id
}

/** Inserts an active listing and, when `sourceCommit` is set, the package's entity source. */
async function insertListing(
	owner: TestUser,
	packageId: string,
	kodyId: string,
	input: { publishedAt?: string; pinnedCommit?: string; sourceCommit?: string },
) {
	const listingId = `listing-${packageId}`
	const publishedAt = input.publishedAt ?? new Date().toISOString()
	await runSql(
		`INSERT INTO community_listings (
			id, owner_user_id, package_id, source_id, kody_id, name, description,
			tags_json, license, pinned_commit, status, created_at, updated_at, published_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
		listingId,
		owner.userId,
		packageId,
		`source-${packageId}`,
		kodyId,
		`@${owner.username}/${kodyId}`,
		`${kodyId} description`,
		JSON.stringify(['catalog']),
		'MIT',
		input.pinnedCommit ?? 'commit-1',
		publishedAt,
		publishedAt,
		publishedAt,
	)
	if (input.sourceCommit) {
		await runSql(
			`INSERT INTO entity_sources (
				id, user_id, entity_kind, entity_id, repo_id, published_commit,
				indexed_commit, manifest_path, source_root, created_at, updated_at
			) VALUES (?, ?, 'package', ?, ?, ?, NULL, 'package.json', '/', ?, ?)`,
			`source-${packageId}`,
			owner.userId,
			packageId,
			`repo-${packageId}`,
			input.sourceCommit,
			fixedNow,
			fixedNow,
		)
	}
	return listingId
}

async function insertTestJob(userId: string, packageId: string) {
	const name = `job ${crypto.randomUUID()} for ${packageId}`
	const id = buildPackageJobId(packageId, name)
	await jobsData(env).insertJob({
		userId,
		callerContextJson: '{}',
		job: {
			version: 1,
			id,
			userId: ownerIdFromStored(userId),
			name,
			sourceId: `source-${packageId}`,
			publishedCommit: null,
			storageId: createJobStorageId(id),
			schedule: { type: 'interval', every: '1h' },
			timezone: 'UTC',
			enabled: true,
			killSwitchEnabled: false,
			expiresAt: null,
			createdAt: fixedNow,
			updatedAt: fixedNow,
			nextRunAt: fixedNow,
			runCount: 0,
			successCount: 0,
			errorCount: 0,
		},
	})
}

function listPackages(
	owner: TestUser,
	input: { query?: string; includePrivate?: boolean } = {},
) {
	return listPublicProfilePackages({
		env,
		ownerStableUserId: owner.userId,
		limit: 10,
		...input,
	})
}

function needsRepublishByKodyId(
	packages: Awaited<ReturnType<typeof listPackages>>,
) {
	return Object.fromEntries(
		packages.map((pkg) => [pkg.kodyId, pkg.needsRepublish]),
	)
}

test('private profiles and their activity are hidden from public reads', async () => {
	const user = await insertUser('actor', {
		visibility: 'private',
		displayName: 'Hidden Person',
	})
	expect(
		await getCommunityProfileByUsername({ env, username: user.username }),
	).toBeNull()
	expect(
		await getCommunityProfileByUsername({
			env,
			username: user.username,
			includePrivate: true,
		}),
	).toMatchObject({
		userId: user.userId,
		username: user.username,
		displayName: 'Hidden Person',
		visibility: 'private',
	})

	const listingId = await insertListing(
		user,
		`pkg-${crypto.randomUUID()}`,
		'notes',
		{},
	)
	await insertCommunityActivityEvent(env.APP_DB, {
		id: crypto.randomUUID(),
		actorUserId: user.userId,
		eventType: 'listing_published',
		listingId,
		createdAt: fixedNow,
	})
	const activity = (isSelf: boolean) =>
		getProfileActivity({ env, actorUserId: user.userId, limit: 10, isSelf })
	expect(
		(await activity(true)).some((item) => item.type === 'listing_published'),
	).toBe(true)
	expect(await activity(false)).toEqual([])
})

test('updateCommunityProfile validates display name and bio bounds', async () => {
	const user = await insertUser('upd')
	const update = (input: {
		displayName?: string
		bio?: string
		visibility?: 'public' | 'private'
	}) => updateCommunityProfile({ env, numericUserId: user.numericId, ...input })

	await expect(update({ displayName: 'x'.repeat(51) })).rejects.toThrow(
		/Display name must be at most 50/,
	)
	await expect(update({ bio: 'y'.repeat(501) })).rejects.toThrow(
		/Bio must be at most 500/,
	)

	invalidateCommunityPublicCache()
	const versionBeforeVisibilityChange = getCommunityPublicCacheVersion()
	await update({
		displayName: '  Nice Name  ',
		bio: '  Hello world  ',
		visibility: 'private',
	})
	expect(getCommunityPublicCacheVersion()).toBe(
		versionBeforeVisibilityChange + 1,
	)
	expect(
		await getCommunityProfileByUsername({
			env,
			username: user.username,
			includePrivate: true,
		}),
	).toMatchObject({
		displayName: 'Nice Name',
		bio: 'Hello world',
		visibility: 'private',
	})

	const versionBeforePublicRestore = getCommunityPublicCacheVersion()
	await update({ displayName: '   ', bio: '' })
	expect(getCommunityPublicCacheVersion()).toBe(versionBeforePublicRestore)

	await update({ visibility: 'public' })
	expect(getCommunityPublicCacheVersion()).toBe(versionBeforePublicRestore + 1)
	expect(
		await getCommunityProfileByUsername({ env, username: user.username }),
	).toMatchObject({
		displayName: user.username,
		bio: null,
		visibility: 'public',
	})
})

test('listPublicProfilePackages filters private/hidden packages and supports query', async () => {
	const owner = await insertUser('pkgs')
	const publicNotesId = await insertSavedPackage(owner, 'public-notes', {
		description: 'public diary helpers',
		tags: ['notes'],
		updatedAt: '2026-07-02T00:00:00.000Z',
	})
	await insertSavedPackage(owner, 'secret-notes', {
		description: 'private diary helpers',
		tags: ['notes'],
		isPrivate: true,
		updatedAt: '2026-07-03T00:00:00.000Z',
	})
	await insertSavedPackage(owner, 'hidden-notes', {
		description: 'hidden diary helpers',
		tags: ['notes'],
		hidden: true,
		updatedAt: '2026-07-04T00:00:00.000Z',
	})
	await insertSavedPackage(owner, 'calendar', {
		description: 'schedule helpers',
		tags: ['calendar'],
		searchText: 'unique-search-oracle-token',
	})

	expect((await listPackages(owner)).map((pkg) => pkg.kodyId).sort()).toEqual([
		'calendar',
		'public-notes',
	])
	expect(
		(await getCommunityProfileByUsername({ env, username: owner.username }))
			?.publicPackageCount,
	).toBe(2)

	// search_text is not publicly searchable (substring-probing oracle).
	const queryCases: Array<[query: string, expected: Array<string>]> = [
		['notes', ['public-notes']],
		['public diary', ['public-notes']],
		['notes calendar', []],
		['unique-search-oracle-token', []],
	]
	for (const [query, expected] of queryCases) {
		const found = await listPackages(owner, { query })
		expect({ query, found: found.map((pkg) => pkg.kodyId) }).toEqual({
			query,
			found: expected,
		})
	}

	const ownInventory = await listPackages(owner, { includePrivate: true })
	expect(
		ownInventory
			.map(({ kodyId, hidden, isPrivate }) => ({ kodyId, hidden, isPrivate }))
			.sort((a, b) => a.kodyId.localeCompare(b.kodyId)),
	).toEqual([
		{ kodyId: 'calendar', hidden: false, isPrivate: false },
		{ kodyId: 'hidden-notes', hidden: true, isPrivate: false },
		{ kodyId: 'public-notes', hidden: false, isPrivate: false },
		{ kodyId: 'secret-notes', hidden: false, isPrivate: true },
	])

	await insertListing(owner, publicNotesId, 'public-notes', {
		publishedAt: '2026-06-01T00:00:00.000Z',
		pinnedCommit: 'commit-listed',
		sourceCommit: 'commit-ahead',
	})
	expect(
		needsRepublishByKodyId(await listPackages(owner, { includePrivate: true })),
	).toMatchObject({ 'public-notes': true, calendar: false })
})

test('listPublicProfilePackages ahead filter ignores post-publish updated_at skew when the pin matches published_commit', async () => {
	const owner = await insertUser('skew')
	// communityPublish writes listing.published_at first, then
	// updateSavedPackage bumps updated_at ~0.8–3s later.
	const updatedAt = '2026-09-11T17:41:55.588Z'
	const publishedAt = '2026-09-11T17:41:54.544Z'
	for (const [kodyId, pinnedCommit] of [
		['grok-bot', 'commit-head'],
		['skills', 'commit-listed'],
	] as const) {
		const id = await insertSavedPackage(owner, kodyId, { updatedAt })
		await insertListing(owner, id, kodyId, {
			publishedAt,
			pinnedCommit,
			sourceCommit: 'commit-head',
		})
	}
	expect(
		needsRepublishByKodyId(await listPackages(owner, { includePrivate: true })),
	).toEqual({ 'grok-bot': false, skills: true })
})

test('listPublicProfilePackages attaches webhook, job, and app signifier counts', async () => {
	const owner = await insertUser('sign')
	const otherOwner = await insertUser('signo')
	const appId = await insertSavedPackage(owner, 'notes-app', { hasApp: true })
	const plainId = await insertSavedPackage(owner, 'notes')
	for (const webhookName of ['inbound', 'alerts']) {
		await runSql(
			`INSERT INTO webhook_endpoints (
				id, user_id, package_id, webhook_name, url_secret_hash, created_at, rotated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			`hook-${webhookName}-${appId}`,
			owner.userId,
			appId,
			webhookName,
			`hash-${webhookName}`,
			fixedNow,
			fixedNow,
		)
	}
	await insertTestJob(owner.userId, appId)
	await insertTestJob(owner.userId, appId)
	await insertTestJob(owner.userId, plainId)
	await insertTestJob(otherOwner.userId, appId)

	const listed = await listPackages(owner)
	expect(listed.find((pkg) => pkg.kodyId === 'notes-app')).toMatchObject({
		hasApp: true,
		webhookCount: 2,
		jobCount: 2,
	})
	expect(listed.find((pkg) => pkg.kodyId === 'notes')).toMatchObject({
		hasApp: false,
		webhookCount: 0,
		jobCount: 1,
	})
})
