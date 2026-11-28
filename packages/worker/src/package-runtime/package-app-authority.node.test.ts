import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personalOrgId,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	revokePackageAppOauthGrantsForPersonApp,
	upsertPackageAppOauthGrant,
} from '#app/package-app-oauth-grants.ts'
import { authorize } from '#worker/authorization/authorize.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { createProfile, type ProfilesCaller } from '#worker/profiles/service.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	createPackageAppVisitorCredentialRequest,
	createPackageAppVisitorPersonalRequest,
	createPackageAppCredentialAuthority,
	findPackageAppPublishRequester,
	forgetPackageAppRunsAs,
	loadPackageAppRunsAs,
	notePackageAppPublishRequester,
	packageAppRunsAsUnavailableMessages,
	packageAppVisitorConsents,
	recordPackageAppPublish,
	recordPackageAppPublisher,
	recordPackageAppPublisherUnknown,
	setPackageAppRunsAsPerson,
} from './package-app-authority.ts'

vi.mock(
	'#worker/test-support/apply-all-migrations.ts',
	async (importOriginal) =>
		(
			await import('#worker/credentials/cached-migrations.test-support.ts')
		).withCachedMigrations(await importOriginal()),
)

const now = '2026-10-24T08:00:00.000Z'

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const env = { APP_DB: db } as Env
	let nextId = 1
	async function seedUser(username: string) {
		const stableUserId = `user-${username}-${crypto.randomUUID()}`
		sqlite
			.prepare(
				`INSERT INTO users (id, username, email, stable_user_id, password_hash, email_verified_at)
				 VALUES (?, ?, ?, ?, 'unused', ?)`,
			)
			.run(nextId++, username, `${username}@example.com`, stableUserId, now)
		await provisionPersonalOrg(db, { stableUserId, username })
		return stableUserId
	}
	const owner = await seedUser('owner')
	const member = await seedUser('member')
	const outsider = await seedUser('outsider')
	const orgId = ownerIdFromStored(`org-${crypto.randomUUID()}`)
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
			 VALUES (?, 'acme', 'pro', ?, ?)`,
		)
		.run(orgId, now, now)
	for (const [userId, role] of [
		[owner, 'owner'],
		[member, 'member'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, ?, ?)`,
			)
			.run(orgId, userId, role, now)
	}
	const scope = { orgId, packageId: `pkg-${crypto.randomUUID()}` }
	async function runsAs() {
		forgetPackageAppRunsAs(scope)
		return await loadPackageAppRunsAs({ env, scope })
	}
	return { sqlite, db, env, owner, member, outsider, orgId, scope, runsAs }
}

test('a team app nobody has published since the change has no runs-as person', async () => {
	const t = await setup()
	expect(await t.runsAs()).toEqual({
		status: 'unavailable',
		reason: 'not-set',
		message: packageAppRunsAsUnavailableMessages['not-set'],
	})
})

test('an app runs as its publisher with their live role in the owning org', async () => {
	const t = await setup()
	await recordPackageAppPublisher({
		db: t.db,
		scope: t.scope,
		personId: t.member,
	})
	const runsAs = await t.runsAs()
	expect(runsAs).toMatchObject({
		status: 'ready',
		personId: t.member,
		source: 'publisher',
		role: 'member',
	})
	if (runsAs.status !== 'ready') throw new Error('expected ready')
	expect(runsAs.request.org.id).toBe(t.orgId)
	expect(runsAs.request.membership?.role).toBe('member')
	expect(runsAs.request.actor?.userId).toBe(t.member)
})

test('a Member republishing keeps the runs-as person an Owner chose', async () => {
	const t = await setup()
	await recordPackageAppPublisher({
		db: t.db,
		scope: t.scope,
		personId: t.owner,
	})
	await setPackageAppRunsAsPerson({
		db: t.db,
		scope: t.scope,
		personId: t.owner,
	})

	await recordPackageAppPublisher({
		db: t.db,
		scope: t.scope,
		personId: t.member,
	})
	expect(await t.runsAs()).toMatchObject({
		status: 'ready',
		personId: t.owner,
		source: 'explicit',
		role: 'owner',
	})
})

test('a personal-org app published with no known person runs as the org owner', async () => {
	const t = await setup()
	const scope = {
		orgId: ownerIdFromStored(t.owner),
		packageId: `pkg-${crypto.randomUUID()}`,
	}
	await recordPackageAppPublisher({ db: t.db, scope, personId: t.owner })
	await recordPackageAppPublisherUnknown({ db: t.db, scope })
	forgetPackageAppRunsAs(scope)
	expect(await loadPackageAppRunsAs({ env: t.env, scope })).toMatchObject({
		status: 'ready',
		personId: t.owner,
		source: 'personal-org',
	})
})

test('a git push notes the pusher, and only a live member of the org is found for that commit', async () => {
	const t = await setup()
	const commit = 'a'.repeat(40)
	await notePackageAppPublishRequester({
		db: t.db,
		scope: t.scope,
		personId: t.member,
		commit,
	})
	expect(
		await findPackageAppPublishRequester({ db: t.db, scope: t.scope, commit }),
	).toBe(t.member)
	expect(
		await findPackageAppPublishRequester({
			db: t.db,
			scope: t.scope,
			commit: 'b'.repeat(40),
		}),
	).toBeNull()

	const outsiderCommit = 'c'.repeat(40)
	await notePackageAppPublishRequester({
		db: t.db,
		scope: t.scope,
		personId: t.outsider,
		commit: outsiderCommit,
	})
	expect(
		await findPackageAppPublishRequester({
			db: t.db,
			scope: t.scope,
			commit: outsiderCommit,
		}),
	).toBeNull()
})

test('a publish with no known person forgets the publisher and keeps the Owner pick', async () => {
	const t = await setup()
	await recordPackageAppPublisher({
		db: t.db,
		scope: t.scope,
		personId: t.member,
	})
	await recordPackageAppPublisherUnknown({ db: t.db, scope: t.scope })
	expect(await t.runsAs()).toMatchObject({
		status: 'unavailable',
		reason: 'not-set',
	})

	await setPackageAppRunsAsPerson({
		db: t.db,
		scope: t.scope,
		personId: t.owner,
	})
	await recordPackageAppPublisherUnknown({ db: t.db, scope: t.scope })
	expect(await t.runsAs()).toMatchObject({
		status: 'ready',
		personId: t.owner,
		source: 'explicit',
	})
})

test('a publish that finishes as the org itself records the person who asked for that commit and keeps the Owner pick', async () => {
	const t = await setup()
	await recordPackageAppPublish({
		db: t.db,
		scope: t.scope,
		personId: t.owner,
	})
	await notePackageAppPublishRequester({
		db: t.db,
		scope: t.scope,
		personId: t.member,
		commit: 'commit-2',
	})
	// Asking changes nothing about the live app.
	expect(await t.runsAs()).toMatchObject({
		personId: t.owner,
		source: 'publisher',
	})
	// Someone else asking for the same commit does not replace the first.
	await notePackageAppPublishRequester({
		db: t.db,
		scope: t.scope,
		personId: t.owner,
		commit: 'commit-2',
	})
	// The durable workflow acts as the owning org id, which is not a person.
	await recordPackageAppPublish({
		db: t.db,
		scope: t.scope,
		personId: t.orgId,
		commit: 'commit-2',
	})
	expect(await t.runsAs()).toMatchObject({
		status: 'ready',
		personId: t.member,
		source: 'publisher',
	})

	await setPackageAppRunsAsPerson({
		db: t.db,
		scope: t.scope,
		personId: t.owner,
	})
	await notePackageAppPublishRequester({
		db: t.db,
		scope: t.scope,
		personId: t.member,
		commit: 'commit-3',
	})
	await recordPackageAppPublish({
		db: t.db,
		scope: t.scope,
		personId: t.orgId,
		commit: 'commit-3',
	})
	expect(await t.runsAs()).toMatchObject({
		status: 'ready',
		personId: t.owner,
		source: 'explicit',
	})
})

test('a publish by an id that is no member, with nobody noted for that commit, forgets the publisher but keeps the Owner pick', async () => {
	const t = await setup()
	await recordPackageAppPublish({
		db: t.db,
		scope: t.scope,
		personId: t.member,
	})
	await notePackageAppPublishRequester({
		db: t.db,
		scope: t.scope,
		personId: t.member,
		commit: 'commit-2',
	})
	// A different commit than the one asked for, and a requester from outside.
	await recordPackageAppPublish({
		db: t.db,
		scope: t.scope,
		personId: t.orgId,
		commit: 'commit-other',
	})
	expect(await t.runsAs()).toMatchObject({
		status: 'unavailable',
		reason: 'not-set',
	})
	await notePackageAppPublishRequester({
		db: t.db,
		scope: t.scope,
		personId: t.outsider,
		commit: 'commit-4',
	})
	await recordPackageAppPublish({
		db: t.db,
		scope: t.scope,
		personId: t.orgId,
		commit: 'commit-4',
	})
	expect(await t.runsAs()).toMatchObject({
		status: 'unavailable',
		reason: 'not-set',
	})

	await setPackageAppRunsAsPerson({
		db: t.db,
		scope: t.scope,
		personId: t.owner,
	})
	await recordPackageAppPublish({
		db: t.db,
		scope: t.scope,
		personId: t.orgId,
		commit: 'commit-5',
	})
	expect(await t.runsAs()).toMatchObject({
		status: 'ready',
		personId: t.owner,
		source: 'explicit',
	})
})

test('overlapping publishes of one package each record the person who asked for their commit', async () => {
	const t = await setup()
	await notePackageAppPublishRequester({
		db: t.db,
		scope: t.scope,
		personId: t.member,
		commit: 'commit-a',
	})
	await notePackageAppPublishRequester({
		db: t.db,
		scope: t.scope,
		personId: t.owner,
		commit: 'commit-b',
	})
	await recordPackageAppPublish({
		db: t.db,
		scope: t.scope,
		personId: t.orgId,
		commit: 'commit-a',
	})
	expect(await t.runsAs()).toMatchObject({
		personId: t.member,
		source: 'publisher',
	})
	await recordPackageAppPublish({
		db: t.db,
		scope: t.scope,
		personId: t.orgId,
		commit: 'commit-b',
	})
	expect(await t.runsAs()).toMatchObject({
		personId: t.owner,
		source: 'publisher',
	})
})

test('an Owner republishing keeps the runs-as person they chose', async () => {
	const t = await setup()
	await setPackageAppRunsAsPerson({
		db: t.db,
		scope: t.scope,
		personId: t.member,
	})
	await recordPackageAppPublisher({
		db: t.db,
		scope: t.scope,
		personId: t.owner,
	})
	expect(await t.runsAs()).toMatchObject({
		status: 'ready',
		personId: t.member,
		source: 'explicit',
	})
})

test('a runs-as person who left the org, or was suspended, fails clearly instead of running as nobody', async () => {
	const t = await setup()
	await recordPackageAppPublisher({
		db: t.db,
		scope: t.scope,
		personId: t.member,
	})
	expect((await t.runsAs()).status).toBe('ready')

	t.sqlite
		.prepare(
			`UPDATE org_memberships SET deleted_at = ? WHERE org_id = ? AND user_id = ?`,
		)
		.run(now, t.orgId, t.member)
	expect(await t.runsAs()).toEqual({
		status: 'unavailable',
		reason: 'person-unavailable',
		message: packageAppRunsAsUnavailableMessages['person-unavailable'],
	})

	t.sqlite
		.prepare(
			`UPDATE org_memberships SET deleted_at = NULL WHERE org_id = ? AND user_id = ?`,
		)
		.run(t.orgId, t.member)
	expect((await t.runsAs()).status).toBe('ready')
	t.sqlite
		.prepare(`UPDATE users SET suspended_at = ? WHERE stable_user_id = ?`)
		.run(now, t.member)
	expect(await t.runsAs()).toMatchObject({
		status: 'unavailable',
		reason: 'person-unavailable',
	})
})

test('an explicit runs-as person must be live too: someone outside the org never runs the app', async () => {
	const t = await setup()
	await setPackageAppRunsAsPerson({
		db: t.db,
		scope: t.scope,
		personId: t.outsider,
	})
	expect(await t.runsAs()).toMatchObject({
		status: 'unavailable',
		reason: 'person-unavailable',
	})
})

test('a personal-org app runs as the person who owns that org', async () => {
	const t = await setup()
	const scope = {
		orgId: ownerIdFromStored(t.owner),
		packageId: `pkg-${crypto.randomUUID()}`,
	}
	forgetPackageAppRunsAs(scope)
	expect(await loadPackageAppRunsAs({ env: t.env, scope })).toMatchObject({
		status: 'ready',
		personId: t.owner,
		source: 'personal-org',
		role: 'owner',
	})
})

test('consent scope: a visitor need resolves only while a live grant covers that exact need', async () => {
	const t = await setup()
	const grantScope = { orgSlug: 'ACME', kodyId: 'board' }
	const consents = (needKey: string, visitorPersonId: string | null) =>
		packageAppVisitorConsents({
			db: t.db,
			visitorPersonId,
			grantScope,
			needKey,
		})

	expect(await consents('calendar', t.outsider)).toBe(false)

	await upsertPackageAppOauthGrant({
		db: t.db,
		personId: t.outsider,
		orgUsername: 'acme',
		kodyId: 'board',
		scopes: ['profile', 'need:notes'],
	})
	expect(await consents('calendar', t.outsider)).toBe(false)
	expect(await consents('notes', t.outsider)).toBe(true)
	// Another visitor's grant never counts.
	expect(await consents('notes', t.member)).toBe(false)
	// Anonymous visitors have no grant.
	expect(await consents('notes', null)).toBe(false)

	const lastUsed = t.sqlite
		.prepare(
			`SELECT last_used_at FROM package_app_oauth_grants WHERE person_id = ?`,
		)
		.get(t.outsider) as { last_used_at: string | null }
	expect(lastUsed.last_used_at).not.toBeNull()
})

test('revoked grant: the next visitor-need call fails, and credential handles stop resolving', async () => {
	const t = await setup()
	const grantId = await upsertPackageAppOauthGrant({
		db: t.db,
		personId: t.outsider,
		orgUsername: 'acme',
		kodyId: 'board',
		scopes: ['profile', 'need:github'],
	})
	const visitorRequest = {
		actor: { userId: t.outsider },
	} as unknown as Parameters<
		typeof createPackageAppCredentialAuthority
	>[0]['visitorRequest']
	const authority = createPackageAppCredentialAuthority({
		env: t.env,
		scope: t.scope,
		grantScope: { orgSlug: 'acme', kodyId: 'board' },
		visitorRequest,
		issue: { visitorNeed: 'github' },
	})
	expect(await authority.visitorNeedRequest('github')).toBe(visitorRequest)
	expect(await authority.visitorNeedGrant('github')).toMatchObject({
		request: visitorRequest,
		grantId,
	})
	expect(await authority.visitorNeedRequest('calendar')).toBeNull()

	await revokePackageAppOauthGrantsForPersonApp({
		db: t.db,
		personId: t.outsider,
		orgUsername: 'acme',
		kodyId: 'board',
	})
	expect(await authority.visitorNeedRequest('github')).toBeNull()
	expect(await authority.visitorNeedGrant('github')).toBeNull()
	expect(
		await packageAppVisitorConsents({
			db: t.db,
			visitorPersonId: t.outsider,
			grantScope: { orgSlug: 'acme', kodyId: 'board' },
			needKey: 'github',
		}),
	).toBe(false)
})

test('visitor credential requests use the visitor personal binding', async () => {
	const t = await setup()
	const visitorOrgId = personalOrgId(personIdFromStored(t.member))
	const request = await createPackageAppVisitorPersonalRequest({
		db: t.db,
		visitor: {
			userId: personIdFromStored(t.member),
			username: 'member',
		},
	})

	expect(request).toMatchObject({
		org: { id: visitorOrgId, slug: 'member' },
		actor: { userId: t.member },
		membership: { role: 'owner' },
		credential: { kind: 'package-app' },
	})
	expect(request?.org.id).not.toBe(t.orgId)
})

test('flag-off visitor credential requests reuse the caller request', async () => {
	const t = await setup()
	const callerRequest = deriveRequestContext({
		user: {
			userId: personIdFromStored(t.member),
			username: 'member',
		},
		source: { kind: 'package-app' },
		orgBinding: {
			org: { id: t.orgId, slug: 'acme' },
			role: 'member',
		},
	})

	const request = await createPackageAppVisitorCredentialRequest({
		db: t.db,
		orgId: t.orgId,
		callerRequest,
		visitor: {
			userId: personIdFromStored(t.member),
			username: 'member',
		},
	})

	expect(request).toBe(callerRequest)
	expect(request?.org.id).toBe(t.orgId)
})

test('runs-as credential handles resolve as the live runs-as person, and stop when that person leaves', async () => {
	const t = await setup()
	await recordPackageAppPublisher({
		db: t.db,
		scope: t.scope,
		personId: t.member,
	})
	forgetPackageAppRunsAs(t.scope)
	const authority = createPackageAppCredentialAuthority({
		env: t.env,
		scope: t.scope,
		grantScope: null,
		visitorRequest: null,
		issue: { runsAs: true },
	})
	expect((await authority.runsAsRequest())?.actor?.userId).toBe(t.member)
	t.sqlite
		.prepare(
			`UPDATE org_memberships SET deleted_at = ? WHERE org_id = ? AND user_id = ?`,
		)
		.run(now, t.orgId, t.member)
	forgetPackageAppRunsAs(t.scope)
	expect(await authority.runsAsRequest()).toBeNull()
})

test('credential gap: a profile visitor only reaches a visitor-need credential its profile was granted', async () => {
	const t = await setup()
	const personalOrg = personalOrgId(personIdFromStored(t.outsider))
	const credentialId = 'cred_github'
	const credential = {
		type: 'credential' as const,
		id: credentialId,
		orgId: personalOrg,
	}
	// The person consented to the app's github need in a browser.
	await upsertPackageAppOauthGrant({
		db: t.db,
		personId: t.outsider,
		orgUsername: 'acme',
		kodyId: 'board',
		scopes: ['profile', 'need:github'],
	})
	const me = {
		env: t.env,
		orgId: personalOrg,
		actor: { userId: t.outsider, profileId: null, isOwner: true },
		holds: () => true,
	} as unknown as ProfilesCaller
	const granted = await createProfile(me, {
		name: 'with-github',
		grants: [
			{
				resourceType: 'credential',
				resourceId: credentialId,
				permissions: ['secret:use'],
			},
		],
	})
	const ungranted = await createProfile(me, { name: 'app-only' })

	async function visitorNeedRequestFor(profileId: string | null) {
		const visitorRequest = await createPackageAppVisitorPersonalRequest({
			db: t.db,
			visitor: {
				userId: personIdFromStored(t.outsider),
				username: 'outsider',
				credential: profileId
					? {
							scopes: null,
							profileId,
							profileChain: [profileId],
							profileOrgId: personalOrg,
						}
					: null,
			},
		})
		const authority = createPackageAppCredentialAuthority({
			env: t.env,
			scope: t.scope,
			grantScope: { orgSlug: 'acme', kodyId: 'board' },
			visitorRequest,
			issue: { visitorNeed: 'github' },
		})
		return await authority.visitorNeedRequest('github')
	}
	const use = async (profileId: string | null) =>
		await authorize(
			{ env: t.env, request: await visitorNeedRequestFor(profileId) },
			'secret:use',
			credential,
		)

	// The person, and a profile granted the credential, resolve the need.
	await expect(use(null)).resolves.toBeUndefined()
	await expect(use(granted.id)).resolves.toBeUndefined()
	// The live consent grant covers the need, yet the profile was never
	// granted the credential, so the visit cannot use it.
	const request = await visitorNeedRequestFor(ungranted.id)
	expect(request).toMatchObject({
		actor: { userId: t.outsider },
		credential: { profileId: ungranted.id },
	})
	await expect(use(ungranted.id)).rejects.toMatchObject({
		code: 'profile_grant',
	})
})
