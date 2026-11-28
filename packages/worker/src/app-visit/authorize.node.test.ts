import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { authorizeAppVisit } from '#worker/app-visit/authorize.ts'
import {
	sessionRequestFor,
	viewerCanExecutePackageApp,
	visitSessionRequestFor,
} from '#app/package-viewer-access.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { appListCapability } from '#mcp/capabilities/packages/app-list.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import {
	grantToProfile,
	createProfile,
	type ProfilesCaller,
} from '#worker/profiles/service.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

vi.mock(
	'#worker/test-support/apply-all-migrations.ts',
	async (importOriginal) =>
		(
			await import('#worker/credentials/cached-migrations.test-support.ts')
		).withCachedMigrations(await importOriginal()),
)

vi.mock('#worker/profiles/flag.ts', () => ({
	isProfilesEnabledFor: async () => true,
}))

const ownerId = personIdFromStored('person-owner')
const memberId = personIdFromStored('person-member')
const outsiderId = personIdFromStored('person-outsider')
const strangerId = personIdFromStored('person-stranger')
const teamId = ownerIdFromStored('org-acme')
const now = '2026-01-01T00:00:00.000Z'

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const kv = new Map<string, string>()
	const env = {
		APP_DB: db,
		BUNDLE_ARTIFACTS_KV: {
			get: async (key: string) => kv.get(key) ?? null,
			put: async (key: string, value: string) => void kv.set(key, value),
		},
	} as unknown as Env
	const insertOrg = sqlite.prepare(
		`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)`,
	)
	const insertHandle = sqlite.prepare(
		`INSERT INTO handles (handle, org_id, created_at) VALUES (?, ?, ?)`,
	)
	const insertMembership = sqlite.prepare(
		`INSERT INTO org_memberships (org_id, user_id, role, created_at)
		 VALUES (?, ?, ?, ?)`,
	)
	const insertUser = sqlite.prepare(
		`INSERT INTO users (id, username, email, stable_user_id, password_hash, email_verified_at)
		 VALUES (?, ?, ?, ?, 'unused', ?)`,
	)
	let nextUserId = 1
	insertOrg.run(teamId, 'acme', 'Acme', now, now)
	insertHandle.run('acme', teamId, now)
	for (const [id, slug] of [
		[ownerId, 'owner'],
		[memberId, 'member'],
		[outsiderId, 'outsider'],
		[strangerId, 'stranger'],
	] as const) {
		insertOrg.run(id, slug, slug, now, now)
		insertHandle.run(slug, id, now)
		insertUser.run(nextUserId++, slug, `${slug}@example.com`, id, now)
		insertMembership.run(id, id, 'owner', now)
	}
	insertMembership.run(teamId, ownerId, 'owner', now)
	insertMembership.run(teamId, memberId, 'member', now)
	const insertGrant = sqlite.prepare(
		`INSERT INTO grants (
			id, org_id, resource_type, resource_id, subject_type, subject_id,
			preset, created_by_user_id, created_at, updated_at, deleted_at
		) VALUES (?, ?, ?, ?, 'user', ?, 'use', ?, ?, ?, NULL)`,
	)
	const insertPermission = sqlite.prepare(
		`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, ?)`,
	)
	for (const [id, name] of [
		['pkg-board', '@acme/board'],
		['pkg-notes', '@acme/notes'],
	] as const) {
		await insertSavedPackage(db, {
			id,
			user_id: teamId,
			name,
			description: name,
			tags_json: '[]',
			search_text: null,
			source_id: `source-${id}`,
			has_app: 1,
			has_skills: 0,
			hidden: 0,
			is_private: 1,
		})
	}
	// The member runs every app in acme; the outsider was shared one app.
	insertGrant.run(
		'grant-member',
		teamId,
		'org',
		teamId,
		memberId,
		ownerId,
		now,
		now,
	)
	insertPermission.run('grant-member', 'app:execute')
	insertGrant.run(
		'grant-outsider',
		teamId,
		'app',
		'pkg-board',
		outsiderId,
		ownerId,
		now,
		now,
	)
	insertPermission.run('grant-outsider', 'app:execute')

	const requestFor = (personId: string, profile?: { id: string } | null) =>
		deriveRequestContext({
			user: { userId: personIdFromStored(personId), username: personId },
			source: profile
				? { kind: 'api-token', tokenId: 'token-1' }
				: { kind: 'mcp-oauth' },
			orgBinding: {
				org: { id: ownerIdFromStored(personId), slug: personId },
				role: 'owner',
			},
			...(profile ? { profileId: profile.id, profileChain: [profile.id] } : {}),
		})
	const profilesCaller = (personId: string, profileId: string | null = null) =>
		({
			env,
			request: requestFor(personId, profileId ? { id: profileId } : null),
			orgId: personId,
			actor: { userId: personId, profileId, isOwner: true },
			// Nothing in the person's own org is at stake in these tests.
			holds: () => false,
		}) as unknown as ProfilesCaller
	const visit = (
		callerRequest: ReturnType<typeof requestFor>,
		appSlug = 'board',
	) => authorizeAppVisit({ env, callerRequest, ownerHandle: 'acme', appSlug })
	const listApps = (
		personId: string,
		args: Record<string, unknown> = {},
		profileId: string | null = null,
	) =>
		appListCapability.handler(args as never, {
			env: { ...env, APP_BASE_URL: 'https://heykody.dev' } as Env,
			callerContext: createMcpCallerContext({
				source: profileId
					? { kind: 'api-token', tokenId: 'token-1' }
					: { kind: 'mcp-oauth' },
				baseUrl: 'https://heykody.dev',
				user: {
					userId: personIdFromStored(personId),
					email: `${personId}@example.com`,
					displayName: personId,
					username: personId,
				},
				orgBinding: {
					org: { id: ownerIdFromStored(personId), slug: personId },
					role: 'owner',
				},
				...(profileId ? { profileId, profileChain: [profileId] } : {}),
			}),
		})
	return { sqlite, env, requestFor, profilesCaller, visit, listApps }
}

const useApp = (appId: string) => ({
	resourceType: 'app' as const,
	resourceId: appId,
	permissions: ['app:execute' as const],
})

test('a member visits an app in their org as themselves', async () => {
	const t = await setup()
	expect(await t.visit(t.requestFor(memberId))).toMatchObject({
		kind: 'ok',
		app: { id: 'pkg-board' },
		visitor: { userId: memberId, role: 'member' },
		billedOrgId: teamId,
		needsRunConsent: false,
	})
})

test('a person shared one app visits it from another org, and nothing else there', async () => {
	const t = await setup()
	const ok = await t.visit(t.requestFor(outsiderId))
	expect(ok).toMatchObject({
		kind: 'ok',
		visitor: { userId: outsiderId, role: null },
		// ADR 0095: a cross-org visit bills the visitor's own org.
		billedOrgId: outsiderId,
		needsRunConsent: true,
	})
	if (ok.kind === 'ok') expect(ok.visitor.profile).toBeUndefined()
	expect(await t.visit(t.requestFor(outsiderId), 'notes')).toMatchObject({
		kind: 'forbidden',
	})
	expect(await t.visit(t.requestFor(strangerId))).toMatchObject({
		kind: 'forbidden',
	})
	// A visit never records the person's "Run as me" confirmation.
	expect(
		t.sqlite
			.prepare(`SELECT COUNT(*) AS n FROM package_app_run_consents`)
			.get(),
	).toEqual({ n: 0 })
})

test('a browser session and an agent request get the same answer from the one check', async () => {
	const t = await setup()
	for (const [personId, slug, appId] of [
		[memberId, 'board', 'pkg-board'],
		[outsiderId, 'board', 'pkg-board'],
		[outsiderId, 'notes', 'pkg-notes'],
		[strangerId, 'board', 'pkg-board'],
	] as const) {
		const viewer = { userId: personId, username: String(personId) }
		const browser = await t.visit(sessionRequestFor(viewer), slug)
		const agent = await t.visit(t.requestFor(personId), slug)
		expect(agent.kind).toBe(browser.kind)
		expect(
			await viewerCanExecutePackageApp({
				env: t.env,
				viewer,
				ownerId: teamId,
				appId,
			}),
		).toBe(browser.kind === 'ok')
	}
})

test('a profile visits a shared app only with its own grant, and the app sees the person plus the profile', async () => {
	const t = await setup()
	const me = t.profilesCaller(outsiderId)
	const agent = await createProfile(me, {
		name: 'agent',
		grants: [useApp('pkg-board')],
	})
	const bare = await createProfile(me, { name: 'bare' })

	const ok = await t.visit(t.requestFor(outsiderId, agent))
	expect(ok).toMatchObject({
		kind: 'ok',
		visitor: {
			userId: outsiderId,
			role: null,
			profile: { id: agent.id, name: 'agent' },
			credential: {
				profileId: agent.id,
				profileChain: [agent.id],
				profileOrgId: outsiderId,
			},
		},
		billedOrgId: outsiderId,
	})
	// The person can run the app; the profile was never given it.
	expect(await t.visit(t.requestFor(outsiderId, bare))).toMatchObject({
		kind: 'forbidden',
		error: { code: 'profile_grant' },
	})
	// The grant is stored in the org that owns the app.
	expect(
		t.sqlite
			.prepare(
				`SELECT org_id, resource_id FROM grants
				 WHERE subject_type = 'profile' AND subject_id = ?`,
			)
			.all(agent.id),
	).toEqual([{ org_id: teamId, resource_id: 'pkg-board' }])

	// Losing the person's own grant closes the profile too.
	t.sqlite
		.prepare(`UPDATE grants SET deleted_at = ? WHERE id = 'grant-outsider'`)
		.run(now)
	t.sqlite.prepare(`UPDATE orgs SET access_epoch = access_epoch + 1`).run()
	expect((await t.visit(t.requestFor(outsiderId, agent))).kind).not.toBe('ok')
})

test('an open-link visit session is checked as the profile and scopes that minted it', async () => {
	const t = await setup()
	const me = t.profilesCaller(outsiderId)
	const agent = await createProfile(me, {
		name: 'agent',
		grants: [useApp('pkg-board')],
	})
	const bare = await createProfile(me, { name: 'bare' })
	const viewer = { userId: outsiderId, username: String(outsiderId) }
	// What the visit cookie stores: the credential of the request that asked
	// for the link, here a profile from another org than the app's.
	const stored = (
		profile: { id: string } | null,
		scopes: Array<'app:execute' | 'package:read'> | null = null,
	) => {
		const { credential } = t.requestFor(outsiderId, profile)
		return {
			kind: credential.kind,
			id: credential.id,
			scopes,
			...(profile
				? {
						profileId: profile.id,
						profileChain: [profile.id],
						profileOrgId: ownerIdFromStored(String(outsiderId)),
					}
				: {}),
		}
	}
	const browserVisit = (credential: ReturnType<typeof stored>) =>
		t.visit(visitSessionRequestFor(viewer, credential))

	// The cross-org profile grant opens the app in the browser exactly as it
	// does through appFetch, and the app sees the person plus the profile.
	const ok = await browserVisit(stored(agent))
	expect(ok.kind).toBe((await t.visit(t.requestFor(outsiderId, agent))).kind)
	expect(ok).toMatchObject({
		kind: 'ok',
		visitor: {
			userId: outsiderId,
			role: null,
			profile: { id: agent.id, name: 'agent' },
		},
		billedOrgId: outsiderId,
	})
	// The person may run the app, but a profile without the grant may not,
	// and neither may a token whose scopes leave out app:execute.
	expect(await browserVisit(stored(bare))).toMatchObject({
		kind: 'forbidden',
		error: { code: 'profile_grant' },
	})
	expect((await browserVisit(stored(agent, ['package:read']))).kind).not.toBe(
		'ok',
	)
	expect((await browserVisit(stored(agent, ['app:execute']))).kind).toBe('ok')
	for (const [credential, allowed] of [
		[stored(agent), true],
		[stored(bare), false],
		[stored(null, ['package:read']), false],
	] as const) {
		expect(
			await viewerCanExecutePackageApp({
				env: t.env,
				viewer,
				ownerId: teamId,
				appId: 'pkg-board',
				credential,
			}),
		).toBe(allowed)
	}

	// Revoking the profile's grant closes a session that is already open.
	t.sqlite
		.prepare(
			`UPDATE grants SET deleted_at = ? WHERE subject_type = 'profile' AND subject_id = ?`,
		)
		.run(now, agent.id)
	t.sqlite.prepare(`UPDATE orgs SET access_epoch = access_epoch + 1`).run()
	expect((await browserVisit(stored(agent))).kind).not.toBe('ok')
})

test('a member profile in the same org needs the app grant', async () => {
	const t = await setup()
	const me = {
		...t.profilesCaller(memberId),
		orgId: teamId,
		holds: () => true,
	} as ProfilesCaller
	const agent = await createProfile(me, {
		name: 'agent',
		grants: [useApp('pkg-board')],
	})
	const request = (profileId: string) =>
		deriveRequestContext({
			user: { userId: memberId, username: 'member' },
			source: { kind: 'api-token', tokenId: 'token-1' },
			orgBinding: { org: { id: teamId, slug: 'acme' }, role: 'member' },
			profileId,
			profileChain: [profileId],
		})
	expect(await t.visit(request(agent.id))).toMatchObject({
		kind: 'ok',
		visitor: {
			userId: memberId,
			role: 'member',
			profile: { id: agent.id, name: 'agent' },
		},
	})
	expect(await t.visit(request(agent.id), 'notes')).toMatchObject({
		kind: 'forbidden',
		error: { code: 'profile_grant' },
	})
})

test('a profile grant on a shared app needs the person to hold it, and a sub-profile cannot exceed its parent', async () => {
	const t = await setup()
	// The stranger cannot run the app, so their profile cannot be given it.
	await expect(
		createProfile(t.profilesCaller(strangerId), {
			name: 'agent',
			grants: [useApp('pkg-board')],
		}),
	).rejects.toMatchObject({ code: 'profile_grant_exceeds_caller' })
	// The outsider was shared board, not notes.
	const me = t.profilesCaller(outsiderId)
	await expect(
		createProfile(me, { name: 'agent', grants: [useApp('pkg-notes')] }),
	).rejects.toMatchObject({ code: 'profile_grant_exceeds_caller' })

	const parent = await createProfile(me, { name: 'parent' })
	await expect(
		createProfile(me, {
			name: 'child',
			parentProfileId: parent.id,
			grants: [useApp('pkg-board')],
		}),
	).rejects.toMatchObject({ code: 'profile_grant_exceeds_parent' })
	await grantToProfile(me, {
		profileId: parent.id,
		grant: useApp('pkg-board'),
		preset: 'use',
		label: '@acme/board',
	})
	const child = await createProfile(me, {
		name: 'child',
		parentProfileId: parent.id,
		grants: [useApp('pkg-board')],
	})
	expect(
		await t.visit(
			deriveRequestContext({
				user: { userId: outsiderId, username: 'outsider' },
				source: { kind: 'api-token', tokenId: 'token-1' },
				orgBinding: {
					org: { id: ownerIdFromStored(`${outsiderId}`), slug: 'outsider' },
					role: 'owner',
				},
				profileId: child.id,
				profileChain: [child.id, parent.id],
			}),
		),
	).toMatchObject({
		kind: 'ok',
		visitor: { profile: { id: child.id, name: 'child' } },
	})
})

test('appList lists apps in member orgs and apps shared from other orgs, narrowed by a profile', async () => {
	const t = await setup()
	await insertSavedPackage(t.env.APP_DB, {
		id: 'pkg-mine',
		user_id: ownerIdFromStored(`${outsiderId}`),
		name: '@outsider/mine',
		description: 'mine',
		tags_json: '[]',
		search_text: null,
		source_id: 'source-mine',
		has_app: 1,
		has_skills: 0,
		hidden: 0,
		is_private: 1,
	})
	const all = await t.listApps(outsiderId)
	expect(all.next_cursor).toBeNull()
	expect(all.apps).toMatchObject([
		{
			app: '@acme/board',
			owner: 'acme',
			package_id: 'pkg-board',
			visibility: 'private',
			shared: true,
		},
		{ app: '@outsider/mine', owner: 'outsider', shared: false },
	])
	expect(all.apps[0]?.hosted_url).toMatch(/^https:\/\//)
	// A member sees every app in the org; nobody sees an org they have no part in.
	expect((await t.listApps(memberId)).apps.map((app) => app.app)).toEqual([
		'@acme/board',
		'@acme/notes',
	])
	expect((await t.listApps(strangerId)).apps).toEqual([])
	expect(
		(await t.listApps(outsiderId, { owner: '@acme' })).apps.map(
			(app) => app.app,
		),
	).toEqual(['@acme/board'])
	const firstPage = await t.listApps(outsiderId, { limit: 1 })
	expect(firstPage).toMatchObject({
		apps: [{ app: '@acme/board' }],
		next_cursor: '1',
	})
	expect(
		(await t.listApps(outsiderId, { limit: 1, cursor: '1' })).apps,
	).toMatchObject([{ app: '@outsider/mine' }])

	// A profile lists only the apps it was given.
	const agent = await createProfile(t.profilesCaller(outsiderId), {
		name: 'agent',
		grants: [useApp('pkg-board')],
	})
	expect(
		(await t.listApps(outsiderId, {}, agent.id)).apps.map((app) => app.app),
	).toEqual(['@acme/board'])
})
