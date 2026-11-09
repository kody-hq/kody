/**
 * A team-org `webhookUrlApply` approval link must name its org, and the page
 * and Allow/Reject must re-bind that org from the session's verified
 * membership: pending and granted rows are keyed by the owning org.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import type { AuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	approveConnectWebhookApply,
	loadConnectWebhookApplyData,
	rejectConnectWebhookApply,
} from '#app/connect-webhook-apply-data.ts'
import { loadOrgBindingForSlug } from '#worker/orgs/repo.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { requireWebhookApplyDestinationGrantOrPending } from '#worker/webhooks/apply-destination-approval.ts'
import { formatWebhookUrlHandle } from '#worker/webhooks/handle.ts'
import { connectWebhookInput } from '../../start/connect-input.ts'

const now = '2026-11-07T00:00:00.000Z'
const baseUrl = 'https://heykody.dev'
const teamOrgId = 'org-acme-team'
const teamSlug = 'acme-team'
const otherOrgId = 'org-other-team'
const otherSlug = 'other-team'
const destination = {
	type: 'http' as const,
	url: 'https://hooks.example/register',
	headers: { 'Content-Type': 'application/json' },
	body: '{"url":"{{webhookUrl}}"}',
}

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const people = {
		owner: testStableUserIdFromEmail('owner@example.com')!,
		member: testStableUserIdFromEmail('member@example.com')!,
		outsider: testStableUserIdFromEmail('outsider@example.com')!,
	}
	for (const [index, [username, stableUserId]] of Object.entries(
		people,
	).entries()) {
		await db
			.prepare(
				`INSERT INTO users (id, username, email, password_hash, created_at, updated_at, stable_user_id)
				 VALUES (?, ?, ?, 'h', ?, ?, ?)`,
			)
			.bind(
				index + 1,
				username,
				`${username}@example.com`,
				now,
				now,
				stableUserId,
			)
			.run()
		await provisionPersonalOrg(db, { stableUserId, username, createdAt: now })
	}
	await db.batch([
		db
			.prepare(
				`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
				 VALUES (?, ?, 'Acme', ?, ?), (?, ?, 'Other', ?, ?)`,
			)
			.bind(teamOrgId, teamSlug, now, now, otherOrgId, otherSlug, now, now),
		db
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, 'owner', ?), (?, ?, 'member', ?), (?, ?, 'owner', ?)`,
			)
			.bind(
				teamOrgId,
				people.owner,
				now,
				teamOrgId,
				people.member,
				now,
				otherOrgId,
				people.owner,
				now,
			),
	])
	const endpoints: Record<string, string> = {}
	for (const [orgId, key] of [
		[teamOrgId, 'team'],
		[otherOrgId, 'other'],
		[people.owner, 'personal'],
	] as const) {
		const packageId = `pkg-${key}`
		endpoints[key] = `endpoint-${key}`
		await db
			.prepare(
				`INSERT INTO saved_packages (
					id, user_id, name, kody_id, description, source_id, created_at, updated_at
				) VALUES (?, ?, 'hooks', 'hooks', 'Hooks', ?, ?, ?)`,
			)
			.bind(packageId, orgId, `src-${key}`, now, now)
			.run()
		await db
			.prepare(
				`INSERT INTO webhook_endpoints (
					id, user_id, package_id, webhook_name, url_secret_hash,
					url_secret_encrypted, created_at, rotated_at
				) VALUES (?, ?, ?, 'incoming', 'hash', 'ciphertext', ?, ?)`,
			)
			.bind(endpoints[key], orgId, packageId, now, now)
			.run()
	}
	const env = { APP_DB: db, AUDIT_DB: createAuditTestDb() } as unknown as Env

	/** The agent's `webhookUrlApply` call, from a verified org binding. */
	const requestApproval = (key: 'team' | 'other' | 'personal') =>
		requireWebhookApplyDestinationGrantOrPending({
			env,
			userId: ownerIdFromStored(
				key === 'team'
					? teamOrgId
					: key === 'other'
						? otherOrgId
						: people.owner,
			),
			orgSlug:
				key === 'team' ? teamSlug : key === 'other' ? otherSlug : 'owner',
			handle: formatWebhookUrlHandle(endpoints[key]!),
			destination,
			baseUrl,
		})

	/**
	 * The website session, bound the way `withWebsiteRead` /
	 * `withWebsiteMutation` bind `?org=`: from the person's live membership.
	 * Without an org the session stays in the person's personal org.
	 */
	const session = async (
		person: keyof typeof people,
		orgSlug: string | undefined,
	): Promise<AuthenticatedAppUser> => {
		const mcpUser = {
			userId: personIdFromStored(people[person]),
			username: person,
		}
		let orgBinding
		if (orgSlug) {
			const binding = await loadOrgBindingForSlug(db, mcpUser.userId, orgSlug)
			if (!binding || binding.role == null)
				throw new Error('Organization not found.')
			orgBinding = binding
		}
		return {
			userId: 0,
			username: person,
			mcpUser,
			request: deriveRequestContext({
				user: mcpUser,
				source: { kind: 'session' },
				orgBinding,
			}),
		} as unknown as AuthenticatedAppUser
	}
	const rows = (table: 'pending' | 'grants', ownerId: string) =>
		sqlite
			.prepare(
				`SELECT webhook_endpoint_id AS endpoint, destination_fingerprint AS fingerprint
				 FROM webhook_apply_destination_${table} WHERE user_id = ?`,
			)
			.all(ownerId)
	return { env, people, endpoints, requestApproval, session, rows }
}

async function linkFrom(
	gate: Awaited<
		ReturnType<typeof requireWebhookApplyDestinationGrantOrPending>
	>,
) {
	if (gate.status !== 'approval_required') throw new Error('expected approval')
	const input = connectWebhookInput(new URL(gate.approvalUrl).search)
	return {
		orgSlug: input.orgSlug,
		handle: input.handle!,
		fingerprint: input.fingerprint!,
		gate,
	}
}

test('team-org approval link names the org, persists pending before returning, and an owner approves it end to end', async () => {
	const t = await setup()
	const gate = await t.requestApproval('team')
	const link = await linkFrom(gate)
	expect(
		new URL(gate.status === 'approval_required' ? gate.approvalUrl : '')
			.pathname,
	).toBe('/connect/webhook-apply')
	expect(link.orgSlug).toBe(teamSlug)
	// The pending row is committed under the team org before the link exists.
	expect(t.rows('pending', teamOrgId)).toEqual([
		{ endpoint: t.endpoints.team, fingerprint: link.fingerprint },
	])
	expect(t.rows('pending', t.people.owner)).toEqual([])

	// Regenerating the same request is idempotent: same link, one pending row.
	const again = await t.requestApproval('team')
	expect(again).toMatchObject({ approvalUrl: link.gate.approvalUrl })
	expect(t.rows('pending', teamOrgId)).toHaveLength(1)

	const owner = await t.session('owner', link.orgSlug)
	await expect(
		loadConnectWebhookApplyData({ env: t.env, user: owner, ...link }),
	).resolves.toMatchObject({
		ok: true,
		packageId: 'pkg-team',
		alreadyGranted: false,
	})
	await expect(
		approveConnectWebhookApply({
			env: t.env,
			user: await t.session('owner', link.orgSlug),
			...link,
		}),
	).resolves.toMatchObject({ ok: true, alreadyGranted: true })
	expect(t.rows('grants', teamOrgId)).toEqual([
		{ endpoint: t.endpoints.team, fingerprint: link.fingerprint },
	])
	expect(t.rows('pending', teamOrgId)).toEqual([])
	await expect(t.requestApproval('team')).resolves.toMatchObject({
		status: 'granted',
		fingerprint: link.fingerprint,
	})
})

test('a team-org link opened without its org scope finds nothing (the reported bug)', async () => {
	const t = await setup()
	const link = await linkFrom(await t.requestApproval('team'))
	const personal = await t.session('owner', undefined)
	await expect(
		loadConnectWebhookApplyData({ env: t.env, user: personal, ...link }),
	).resolves.toEqual({
		ok: false,
		error:
			'No pending or approved webhook apply destination matches this link.',
		handle: link.handle,
		fingerprint: link.fingerprint,
	})
	await expect(
		approveConnectWebhookApply({ env: t.env, user: personal, ...link }),
	).resolves.toMatchObject({ ok: false })
	expect(t.rows('grants', teamOrgId)).toEqual([])
	expect(t.rows('pending', teamOrgId)).toHaveLength(1)
})

test('an owner can reject a team-org destination', async () => {
	const t = await setup()
	const link = await linkFrom(await t.requestApproval('team'))
	await expect(
		rejectConnectWebhookApply({
			env: t.env,
			user: await t.session('owner', link.orgSlug),
			...link,
		}),
	).resolves.toMatchObject({ ok: false, error: /Approval rejected/ })
	expect(t.rows('pending', teamOrgId)).toEqual([])
	expect(t.rows('grants', teamOrgId)).toEqual([])
})

test('a team member without package Write cannot view, approve, or reject', async () => {
	const t = await setup()
	const link = await linkFrom(await t.requestApproval('team'))
	const view = await loadConnectWebhookApplyData({
		env: t.env,
		user: await t.session('member', link.orgSlug),
		...link,
	})
	expect(view).toMatchObject({ ok: false })
	expect(view).not.toHaveProperty('destination')
	for (const decide of [
		approveConnectWebhookApply,
		rejectConnectWebhookApply,
	]) {
		await expect(
			decide({
				env: t.env,
				user: await t.session('member', link.orgSlug),
				...link,
			}),
		).resolves.toMatchObject({ ok: false })
	}
	expect(t.rows('grants', teamOrgId)).toEqual([])
	expect(t.rows('pending', teamOrgId)).toHaveLength(1)
})

test('a non-member cannot bind the team org from the link query', async () => {
	const t = await setup()
	const link = await linkFrom(await t.requestApproval('team'))
	await expect(t.session('outsider', link.orgSlug)).rejects.toThrow(
		'Organization not found.',
	)
	// Their own personal scope does not own the rows either.
	const personal = await t.session('outsider', undefined)
	await expect(
		loadConnectWebhookApplyData({ env: t.env, user: personal, ...link }),
	).resolves.toMatchObject({ ok: false })
	for (const decide of [
		approveConnectWebhookApply,
		rejectConnectWebhookApply,
	]) {
		await expect(
			decide({ env: t.env, user: personal, ...link }),
		).resolves.toMatchObject({ ok: false })
	}
	expect(t.rows('grants', teamOrgId)).toEqual([])
	expect(t.rows('pending', teamOrgId)).toHaveLength(1)
})

test('another org the same owner belongs to cannot view, approve, or reject the team link', async () => {
	const t = await setup()
	const link = await linkFrom(await t.requestApproval('team'))
	const crossOrg = { ...link, orgSlug: otherSlug }
	await expect(
		loadConnectWebhookApplyData({
			env: t.env,
			user: await t.session('owner', crossOrg.orgSlug),
			...crossOrg,
		}),
	).resolves.toMatchObject({ ok: false })
	for (const decide of [
		approveConnectWebhookApply,
		rejectConnectWebhookApply,
	]) {
		await expect(
			decide({
				env: t.env,
				user: await t.session('owner', crossOrg.orgSlug),
				...crossOrg,
			}),
		).resolves.toMatchObject({ ok: false })
	}
	expect(t.rows('grants', teamOrgId)).toEqual([])
	expect(t.rows('grants', otherOrgId)).toEqual([])
	expect(t.rows('pending', teamOrgId)).toHaveLength(1)
})

test('personal approval links still work with and without the personal org slug', async () => {
	const t = await setup()
	const link = await linkFrom(await t.requestApproval('personal'))
	expect(link.orgSlug).toBe('owner')
	expect(t.rows('pending', t.people.owner)).toHaveLength(1)
	await expect(
		loadConnectWebhookApplyData({
			env: t.env,
			user: await t.session('owner', undefined),
			...link,
		}),
	).resolves.toMatchObject({ ok: true, packageId: 'pkg-personal' })
	await expect(
		approveConnectWebhookApply({
			env: t.env,
			user: await t.session('owner', link.orgSlug),
			...link,
		}),
	).resolves.toMatchObject({ ok: true, alreadyGranted: true })
	expect(t.rows('grants', t.people.owner)).toHaveLength(1)
	expect(t.rows('grants', teamOrgId)).toEqual([])
})
