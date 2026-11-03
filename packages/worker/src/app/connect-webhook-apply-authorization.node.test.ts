/**
 * Approving a `/connect/webhook-apply` destination lets `webhookUrlApply`
 * send the org's webhook URL there, so viewing, approving, and rejecting the
 * link need Write on the webhook's package, the same as `webhookUrlApply`.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import type { OrgRole } from '@kody-internal/shared/request-context.ts'
import { expect, test } from 'vitest'
import type { AuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	approveConnectWebhookApply,
	loadConnectWebhookApplyData,
	rejectConnectWebhookApply,
} from '#app/connect-webhook-apply-data.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import {
	hasWebhookApplyDestinationGrant,
	toHttpApplyDestinationSnapshot,
	upsertWebhookApplyDestinationPending,
} from '#worker/webhooks/apply-destination-approval.ts'
import { formatWebhookUrlHandle } from '#worker/webhooks/handle.ts'

const now = '2026-10-30T00:00:00.000Z'
const packageId = 'pkg-webhooks'
const endpointId = 'endpoint-apply'
const fingerprint = 'fp-apply'

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const ownerId = testStableUserIdFromEmail('owner@example.com')!
	const memberId = testStableUserIdFromEmail('member@example.com')!
	for (const [index, [stableUserId, username]] of [
		[ownerId, 'owneruser'],
		[memberId, 'memberuser'],
	].entries()) {
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
		await provisionPersonalOrg(db, {
			stableUserId: stableUserId!,
			username: username!,
			createdAt: now,
		})
	}
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(ownerId, memberId, now)
		.run()
	await db
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, source_id, created_at, updated_at
			) VALUES (?, ?, 'hooks', 'hooks', 'Hooks', 'src-hooks', ?, ?)`,
		)
		.bind(packageId, ownerId, now, now)
		.run()
	await db
		.prepare(
			`INSERT INTO webhook_endpoints (
				id, user_id, package_id, webhook_name, url_secret_hash,
				url_secret_encrypted, created_at, rotated_at
			) VALUES (?, ?, ?, 'incoming', 'hash', 'ciphertext', ?, ?)`,
		)
		.bind(endpointId, ownerId, packageId, now, now)
		.run()
	const requestPending = () =>
		upsertWebhookApplyDestinationPending({
			db,
			userId: ownerId,
			endpointId,
			fingerprint,
			destination: toHttpApplyDestinationSnapshot({
				type: 'http',
				url: 'https://hooks.example/register',
			}),
			packageId,
			webhookName: 'incoming',
			now,
		})
	await requestPending()
	const env = { APP_DB: db, AUDIT_DB: createAuditTestDb() } as unknown as Env
	// A fresh session per call: permissions are memoized per request context.
	const userAs = (userId: string, username: string, role: OrgRole) => {
		const mcpUser = { userId: personIdFromStored(userId), username }
		return {
			userId: 0,
			username,
			mcpUser,
			request: deriveRequestContext({
				user: mcpUser,
				source: { kind: 'session' },
				orgBinding: {
					org: { id: ownerIdFromStored(ownerId), slug: 'owneruser' },
					role,
				},
			}),
		} as unknown as AuthenticatedAppUser
	}
	const link = { handle: formatWebhookUrlHandle(endpointId), fingerprint }
	const pendingCount = async () =>
		(await db
			.prepare(
				`SELECT COUNT(*) AS n FROM webhook_apply_destination_pending
				 WHERE user_id = ? AND webhook_endpoint_id = ?`,
			)
			.bind(ownerId, endpointId)
			.first<{ n: number }>())!.n
	const granted = () =>
		hasWebhookApplyDestinationGrant({
			db,
			userId: ownerId,
			endpointId,
			fingerprint,
		})
	return {
		env,
		link,
		requestPending,
		pendingCount,
		granted,
		owner: () => userAs(ownerId, 'owneruser', 'owner'),
		member: () => userAs(memberId, 'memberuser', 'member'),
	}
}

test('a member without package Write cannot view, approve, or reject a webhook apply destination', async () => {
	const t = await setup()

	const view = await loadConnectWebhookApplyData({
		env: t.env,
		user: t.member(),
		...t.link,
	})
	expect(view).toMatchObject({ ok: false })
	expect(view).not.toHaveProperty('destination')

	await expect(
		approveConnectWebhookApply({ env: t.env, user: t.member(), ...t.link }),
	).resolves.toMatchObject({ ok: false })
	await expect(t.granted()).resolves.toBe(false)

	await expect(
		rejectConnectWebhookApply({ env: t.env, user: t.member(), ...t.link }),
	).resolves.toMatchObject({ ok: false })
	await expect(t.pendingCount()).resolves.toBe(1)
})

test('an owner can view, approve, and reject a webhook apply destination', async () => {
	const t = await setup()

	await expect(
		loadConnectWebhookApplyData({ env: t.env, user: t.owner(), ...t.link }),
	).resolves.toMatchObject({ ok: true, packageId, alreadyGranted: false })
	await expect(
		approveConnectWebhookApply({ env: t.env, user: t.owner(), ...t.link }),
	).resolves.toMatchObject({ ok: true, alreadyGranted: true })
	await expect(t.granted()).resolves.toBe(true)

	const other = await setup()
	await expect(
		rejectConnectWebhookApply({
			env: other.env,
			user: other.owner(),
			...other.link,
		}),
	).resolves.toMatchObject({ ok: false })
	await expect(other.pendingCount()).resolves.toBe(0)
})
