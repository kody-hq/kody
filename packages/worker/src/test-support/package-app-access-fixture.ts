import { applyD1Migrations, type D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { createPackageAppSessionCookie } from '#app/package-app-session.ts'
import { ensureOpenLinkTestSchema } from '#worker/app-visit/open-link-test-schema.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { entitySourcesTableSql } from '#worker/repo/entity-sources-test-schema.ts'
import { ensureAuditEventsTestSchema } from '#worker/test-support/audit-events-test-schema.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	ensurePackageSubscriptionTestSchema,
	ensureRbacTestSchema,
	seedAccount,
} from '#worker/test-support/workers-seed.ts'

/**
 * One team org with a private app, an approved internet-visible app, and an
 * internet-visible app with no capability approval, plus one
 * person per package-app actor: the org owner, a member holding an org-level
 * `app:execute` grant, and an outside collaborator holding `app:execute` on
 * the private app only. Anonymous visitors need no row.
 */
export const accessFixture = {
	orgSlug: 'cost-apps',
	orgId: testStableUserIdFromEmail('cost-apps-org@example.com'),
	privateApp: { id: 'pkg-cost-private', slug: 'demo' },
	publicApp: {
		id: 'pkg-cost-public',
		slug: 'site',
		approvedCommit: 'commit-cost-public',
	},
	/** Internet-visible, but its owner never approved a capability set. */
	unapprovedPublicApp: { id: 'pkg-cost-unapproved', slug: 'draft' },
	people: {
		owner: { email: 'cost-owner@example.com', username: 'cost-owner' },
		member: { email: 'cost-member@example.com', username: 'cost-member' },
		collaborator: {
			email: 'cost-collab@example.com',
			username: 'cost-collab',
		},
	},
} as const

export type AccessFixturePerson = keyof typeof accessFixture.people

export const accessFixtureOrigin = `https://${accessFixture.orgSlug}.packages.isolated.test`

const now = '2026-10-14T00:00:00.000Z'

async function run(sql: string, ...values: Array<unknown>) {
	await env.APP_DB.prepare(sql)
		.bind(...values)
		.run()
}

export async function seedPackageAppAccessFixture() {
	await ensureRbacTestSchema(env.APP_DB)
	await ensureOpenLinkTestSchema(env.APP_DB)
	await ensurePackageSubscriptionTestSchema(env.APP_DB)
	await ensureOrgsTestSchema(env.APP_DB)
	const { TEST_MIGRATIONS } = env as Env & {
		TEST_MIGRATIONS: Array<D1Migration>
	}
	await applyD1Migrations(
		env.APP_DB,
		TEST_MIGRATIONS.filter(({ name }) =>
			name.endsWith('-package-app-run-consents.sql'),
		),
	)
	try {
		await env.APP_DB.prepare(
			`ALTER TABLE users ADD COLUMN password_changed_at TEXT`,
		).run()
	} catch {
		// Column already present from an earlier seed.
	}
	await ensureAuditEventsTestSchema(env.AUDIT_DB)
	for (const person of Object.values(accessFixture.people)) {
		await seedAccount({
			db: env.APP_DB,
			email: person.email,
			username: person.username,
		})
	}
	const { orgId, orgSlug, privateApp, publicApp, unapprovedPublicApp } =
		accessFixture
	const ownerId = testStableUserIdFromEmail(accessFixture.people.owner.email)
	const memberId = testStableUserIdFromEmail(accessFixture.people.member.email)
	const collaboratorId = testStableUserIdFromEmail(
		accessFixture.people.collaborator.email,
	)
	await run(
		`INSERT OR IGNORE INTO orgs (id, slug, display_name, plan, created_at, updated_at)
		 VALUES (?, ?, 'Cost Apps', 'free', ?, ?)`,
		orgId,
		orgSlug,
		now,
		now,
	)
	await run(
		`INSERT OR IGNORE INTO handles (handle, org_id, created_at) VALUES (?, ?, ?)`,
		orgSlug,
		orgId,
		now,
	)
	for (const [personId, role] of [
		[ownerId, 'owner'],
		[memberId, 'member'],
	] as const) {
		await run(
			`INSERT OR IGNORE INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, ?, ?)`,
			orgId,
			personId,
			role,
			now,
		)
	}
	for (const grant of [
		{
			id: 'grant-cost-member',
			resourceType: 'org',
			resourceId: orgId,
			subjectId: memberId,
		},
		{
			id: 'grant-cost-collab',
			resourceType: 'app',
			resourceId: privateApp.id,
			subjectId: collaboratorId,
		},
	]) {
		await run(
			`INSERT OR IGNORE INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				preset, created_by_user_id, created_at, updated_at
			) VALUES (?, ?, ?, ?, 'user', ?, 'use', ?, ?, ?)`,
			grant.id,
			orgId,
			grant.resourceType,
			grant.resourceId,
			grant.subjectId,
			ownerId,
			now,
			now,
		)
		await run(
			`INSERT OR IGNORE INTO grant_permissions (grant_id, permission)
			 VALUES (?, 'app:execute')`,
			grant.id,
		)
	}
	for (const app of [
		{ ...privateApp, internetVisible: 0 },
		{ ...publicApp, internetVisible: 1 },
		{ ...unapprovedPublicApp, internetVisible: 1 },
	]) {
		await run(
			`INSERT OR IGNORE INTO saved_packages (
				id, user_id, name, kody_id, description, tags_json, search_text,
				source_id, has_app, hidden, is_private, is_internet_visible,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, '', '[]', NULL, ?, 1, 0, 1, ?, ?, ?)`,
			app.id,
			orgId,
			`@${orgSlug}/${app.slug}`,
			app.slug,
			`src-${app.id}`,
			app.internetVisible,
			now,
			now,
		)
	}
	// Anonymous visitors run an approval only against the app's live source.
	await run(entitySourcesTableSql)
	for (const app of [publicApp, unapprovedPublicApp]) {
		await run(
			`INSERT OR IGNORE INTO entity_sources (
				id, user_id, entity_kind, entity_id, repo_id, published_commit,
				serving_commit, manifest_path, source_root, created_at, updated_at
			) VALUES (?, ?, 'package', ?, ?, ?, ?, 'package.json', '/', ?, ?)`,
			`src-${app.id}`,
			orgId,
			app.id,
			`repo-${app.id}`,
			publicApp.approvedCommit,
			publicApp.approvedCommit,
			now,
			now,
		)
	}
	// Workers-unit D1 starts empty; production applies migration 0124.
	await run(
		`CREATE TABLE IF NOT EXISTS package_capability_approvals (
			id TEXT PRIMARY KEY NOT NULL,
			package_id TEXT NOT NULL,
			owner_user_id TEXT NOT NULL,
			published_commit TEXT NOT NULL,
			fingerprint TEXT NOT NULL,
			capability_set_json TEXT NOT NULL,
			dependency_snapshot_json TEXT NOT NULL DEFAULT '{}',
			approved_by_user_id TEXT NOT NULL,
			approved_at TEXT NOT NULL,
			created_at TEXT NOT NULL,
			served_at TEXT
		)`,
	)
	await run(
		`INSERT OR IGNORE INTO package_capability_approvals (
			id, package_id, owner_user_id, published_commit, fingerprint,
			capability_set_json, approved_by_user_id, approved_at, created_at
		) VALUES ('approval-cost-public', ?, ?, ?, 'fingerprint-cost', '[]', ?, ?, ?)`,
		publicApp.id,
		orgId,
		publicApp.approvedCommit,
		ownerId,
		now,
		now,
	)
}

/** Audit rows the package-app access gate wrote for `action`. */
export async function packageAppAccessAuditRows(action: string) {
	const { results } = await env.AUDIT_DB.prepare(
		`SELECT action, result, path, reason FROM audit_events WHERE action = ?
		 ORDER BY id`,
	)
		.bind(action)
		.all<{ action: string; result: string; path: string; reason: string }>()
	return results
}

/** A per-app `kody_pkg_session_*` cookie pair for `person` on the fixture org host. */
export async function packageAppSessionCookieFor(
	person: AccessFixturePerson,
	slug: string = accessFixture.privateApp.slug,
) {
	const setCookies = await createPackageAppSessionCookie({
		env,
		session: {
			stableUserId: testStableUserIdFromEmail(
				accessFixture.people[person].email,
			),
			username: accessFixture.orgSlug,
		},
		slug,
		secure: true,
		expiresAt: Date.now() + 60 * 60 * 1000,
	})
	return setCookies[0]?.split(';')[0] ?? ''
}
