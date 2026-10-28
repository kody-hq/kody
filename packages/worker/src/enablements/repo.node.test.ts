import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	buildInsertEnablementStatement,
	buildInsertWebhookEnablementStatement,
	disableEnablement,
	EmailSenderEnablementConflict,
	getWebhookEnablementPresence,
	insertEnablement,
	isWebhookOneLiveConflict,
	listEnablementsForInstance,
	listEnablementsForOrg,
	pauseEnablement,
	resumeEnablement,
} from './repo.ts'

function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return createD1FromSqlite(sqlite)
}

test('an enablement moves on, paused, on, off, and off is final', async () => {
	const db = setup()
	const created = await insertEnablement({
		db,
		enablement: {
			orgId: 'org-1',
			packageId: 'pkg-1',
			triggerKind: 'subscription',
			triggerName: 'email.message.received',
			instanceId: 'pkg-1',
			enablerUserId: 'user-1',
			origin: 'enabled',
		},
	})
	expect(created).toMatchObject({
		state: 'on',
		pause: null,
		origin: 'enabled',
		senderKind: null,
		senderValue: null,
	})

	const pause = {
		reason: 'credential_access' as const,
		permission: 'secret:use',
		resourceType: 'secret',
		resourceId: 'orgToken',
	}
	expect(
		await pauseEnablement({ db, orgId: 'org-1', id: created.id, pause }),
	).toBe(true)
	expect(
		await pauseEnablement({ db, orgId: 'org-1', id: created.id, pause }),
	).toBe(false)
	const [paused] = await listEnablementsForInstance({
		db,
		orgId: 'org-1',
		triggerKind: 'subscription',
		instanceId: 'pkg-1',
		triggerName: 'email.message.received',
	})
	expect(paused).toMatchObject({
		state: 'paused',
		pause: {
			reason: 'credential_access',
			permission: 'secret:use',
			resourceType: 'secret',
			resourceId: 'orgToken',
		},
	})
	expect(
		await listEnablementsForInstance({
			db,
			orgId: 'org-1',
			triggerKind: 'subscription',
			instanceId: 'pkg-1',
			triggerName: 'package.published',
		}),
	).toEqual([])

	expect(await resumeEnablement({ db, orgId: 'org-1', id: created.id })).toBe(
		true,
	)
	expect(await resumeEnablement({ db, orgId: 'org-1', id: created.id })).toBe(
		false,
	)
	// Another org cannot touch it.
	expect(await disableEnablement({ db, orgId: 'org-2', id: created.id })).toBe(
		false,
	)
	expect(await disableEnablement({ db, orgId: 'org-1', id: created.id })).toBe(
		true,
	)
	expect(
		await pauseEnablement({ db, orgId: 'org-1', id: created.id, pause }),
	).toBe(false)
	expect(await resumeEnablement({ db, orgId: 'org-1', id: created.id })).toBe(
		false,
	)
	expect(await listEnablementsForOrg({ db, orgId: 'org-1' })).toEqual([])
	expect(
		await listEnablementsForOrg({ db, orgId: 'org-1', includeOff: true }),
	).toMatchObject([{ id: created.id, state: 'off' }])
})

const webhookEnablement = (enablerUserId: string) => ({
	orgId: 'org-1',
	packageId: 'pkg-1',
	triggerKind: 'webhook' as const,
	triggerName: 'incoming',
	instanceId: 'endpoint-1',
	enablerUserId,
	origin: 'enabled' as const,
})

test('webhook enablement presence distinguishes never, live, and off', async () => {
	const db = setup()
	const input = {
		db,
		orgId: 'org-1',
		endpointId: 'endpoint-1',
	}
	expect(await getWebhookEnablementPresence(input)).toBe('never')

	const inserted = await insertEnablement({
		db,
		enablement: webhookEnablement('user-1'),
	})
	expect(await getWebhookEnablementPresence(input)).toBe('live')
	await pauseEnablement({
		db,
		orgId: 'org-1',
		id: inserted.id,
		pause: {
			reason: 'org_access',
			permission: null,
			resourceType: null,
			resourceId: null,
		},
	})
	expect(await getWebhookEnablementPresence(input)).toBe('live')
	await disableEnablement({ db, orgId: 'org-1', id: inserted.id })
	expect(await getWebhookEnablementPresence(input)).toBe('off')
})

test('a webhook instance holds at most one live enablement; cron and subscription hold several', async () => {
	const db = setup()
	const now = '2026-10-13T00:00:00.000Z'
	const insertWebhook = async (enablerUserId: string) =>
		await buildInsertWebhookEnablementStatement({
			db,
			enablement: webhookEnablement(enablerUserId),
			now,
		}).statement.run()

	expect((await insertWebhook('user-1')).meta.changes).toBe(1)
	// The conditional insert writes nothing for a second enabler.
	expect((await insertWebhook('user-2')).meta.changes).toBe(0)
	expect(
		await listEnablementsForInstance({
			db,
			orgId: 'org-1',
			triggerKind: 'webhook',
			instanceId: 'endpoint-1',
		}),
	).toMatchObject([{ enablerUserId: 'user-1' }])

	// A plain insert that slips past the check hits the unique index.
	const conflict = await buildInsertEnablementStatement({
		db,
		enablement: webhookEnablement('user-2'),
		now,
	})
		.statement.run()
		.then(
			() => null,
			(error: unknown) => error,
		)
	expect(isWebhookOneLiveConflict(conflict)).toBe(true)
	expect(
		isWebhookOneLiveConflict(new Error('UNIQUE constraint failed: x.y')),
	).toBe(false)

	// Another instance, and another org's same instance id, are independent.
	await buildInsertWebhookEnablementStatement({
		db,
		enablement: { ...webhookEnablement('user-2'), instanceId: 'endpoint-2' },
		now,
	}).statement.run()
	await buildInsertWebhookEnablementStatement({
		db,
		enablement: { ...webhookEnablement('user-2'), orgId: 'org-2' },
		now,
	}).statement.run()

	// Off frees the slot.
	const [live] = await listEnablementsForInstance({
		db,
		orgId: 'org-1',
		triggerKind: 'webhook',
		instanceId: 'endpoint-1',
	})
	await disableEnablement({ db, orgId: 'org-1', id: live!.id })
	expect((await insertWebhook('user-2')).meta.changes).toBe(1)

	for (const [kind, name] of [
		['cron', 'daily'],
		['subscription', 'topic.a'],
	] as const) {
		for (const enablerUserId of ['user-1', 'user-2']) {
			await insertEnablement({
				db,
				enablement: {
					...webhookEnablement(enablerUserId),
					triggerKind: kind,
					triggerName: name,
					instanceId: `${kind}-instance`,
				},
			})
		}
		expect(
			await listEnablementsForInstance({
				db,
				orgId: 'org-1',
				triggerKind: kind,
				instanceId: `${kind}-instance`,
			}),
		).toHaveLength(2)
	}

	expect(() =>
		buildInsertWebhookEnablementStatement({
			db,
			enablement: { ...webhookEnablement('user-1'), triggerKind: 'cron' },
			now,
		}),
	).toThrow('one-live')
})

test('an enablement stores an inbound sender rule', async () => {
	const db = setup()
	const created = await insertEnablement({
		db,
		enablement: {
			orgId: 'org-1',
			packageId: 'pkg-1',
			triggerKind: 'subscription',
			triggerName: 'email.message.received',
			instanceId: 'pkg-1',
			enablerUserId: 'user-1',
			origin: 'enabled',
			senderKind: 'address',
			senderValue: 'receipts@shop.example',
		},
	})
	expect(created).toMatchObject({
		senderKind: 'address',
		senderValue: 'receipts@shop.example',
	})
	const [listed] = await listEnablementsForInstance({
		db,
		orgId: 'org-1',
		triggerKind: 'subscription',
		instanceId: 'pkg-1',
		triggerName: 'email.message.received',
	})
	expect(listed).toMatchObject({
		id: created.id,
		senderKind: 'address',
		senderValue: 'receipts@shop.example',
	})
})

test('a second live email sender enablement adopts the same enabler or conflicts', async () => {
	const db = setup()
	const sender = {
		orgId: 'org-1',
		packageId: 'pkg-1',
		triggerKind: 'subscription' as const,
		triggerName: 'email.message.received',
		instanceId: 'pkg-1',
		origin: 'enabled' as const,
		senderKind: 'address' as const,
		senderValue: 'receipts@shop.example',
	}
	const first = await insertEnablement({
		db,
		enablement: { ...sender, enablerUserId: 'user-1' },
	})
	const again = await insertEnablement({
		db,
		enablement: { ...sender, enablerUserId: 'user-1' },
	})
	expect(again.id).toBe(first.id)
	await expect(
		insertEnablement({
			db,
			enablement: { ...sender, enablerUserId: 'user-2' },
		}),
	).rejects.toBeInstanceOf(EmailSenderEnablementConflict)
	const other = await insertEnablement({
		db,
		enablement: {
			...sender,
			enablerUserId: 'user-1',
			senderValue: 'other@shop.example',
		},
	})
	expect(other.id).not.toBe(first.id)
	expect(
		await listEnablementsForInstance({
			db,
			orgId: 'org-1',
			triggerKind: 'subscription',
			instanceId: 'pkg-1',
			triggerName: 'email.message.received',
		}),
	).toHaveLength(2)
})

test('sender writes store a canonical form so case variants share one live rule', async () => {
	const db = setup()
	const created = await insertEnablement({
		db,
		enablement: {
			orgId: 'org-1',
			packageId: 'pkg-1',
			triggerKind: 'subscription',
			triggerName: 'email.message.received',
			instanceId: 'pkg-1',
			enablerUserId: 'user-1',
			origin: 'enabled',
			senderKind: 'address',
			senderValue: 'Receipts@Shop.Example',
		},
	})
	expect(created.senderValue).toBe('receipts@shop.example')
	const again = await insertEnablement({
		db,
		enablement: {
			orgId: 'org-1',
			packageId: 'pkg-1',
			triggerKind: 'subscription',
			triggerName: 'email.message.received',
			instanceId: 'pkg-1',
			enablerUserId: 'user-1',
			origin: 'enabled',
			senderKind: 'address',
			senderValue: 'RECEIPTS@shop.example',
		},
	})
	expect(again.id).toBe(created.id)
	await expect(
		insertEnablement({
			db,
			enablement: {
				orgId: 'org-1',
				packageId: 'pkg-1',
				triggerKind: 'subscription',
				triggerName: 'email.message.received',
				instanceId: 'pkg-1',
				enablerUserId: 'user-2',
				origin: 'enabled',
				senderKind: 'address',
				senderValue: 'receipts@SHOP.example',
			},
		}),
	).rejects.toBeInstanceOf(EmailSenderEnablementConflict)

	const domain = await insertEnablement({
		db,
		enablement: {
			orgId: 'org-1',
			packageId: 'pkg-1',
			triggerKind: 'subscription',
			triggerName: 'email.message.received',
			instanceId: 'pkg-1',
			enablerUserId: 'user-1',
			origin: 'enabled',
			senderKind: 'domain',
			senderValue: '@Shop.Example',
		},
	})
	expect(domain.senderValue).toBe('shop.example')
	const domainAgain = await insertEnablement({
		db,
		enablement: {
			orgId: 'org-1',
			packageId: 'pkg-1',
			triggerKind: 'subscription',
			triggerName: 'email.message.received',
			instanceId: 'pkg-1',
			enablerUserId: 'user-1',
			origin: 'enabled',
			senderKind: 'domain',
			senderValue: 'SHOP.EXAMPLE',
		},
	})
	expect(domainAgain.id).toBe(domain.id)

	const catchAll = await insertEnablement({
		db,
		enablement: {
			orgId: 'org-1',
			packageId: 'pkg-1',
			triggerKind: 'subscription',
			triggerName: 'email.message.received',
			instanceId: 'pkg-1',
			enablerUserId: 'user-1',
			origin: 'enabled',
			senderKind: 'any_authenticated',
			senderValue: 'ignored@shop.example',
		},
	})
	expect(catchAll.senderValue).toBeNull()
})

test('a blank address sender is refused instead of becoming a live empty rule', async () => {
	const db = setup()
	expect(() =>
		buildInsertEnablementStatement({
			db,
			enablement: {
				orgId: 'org-1',
				packageId: 'pkg-1',
				triggerKind: 'subscription',
				triggerName: 'email.message.received',
				instanceId: 'pkg-1',
				enablerUserId: 'user-1',
				origin: 'enabled',
				senderKind: 'address',
				senderValue: 'not-an-email',
			},
			now: new Date().toISOString(),
		}),
	).toThrow(/usable sender/)
})
