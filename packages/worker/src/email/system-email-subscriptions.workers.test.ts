import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { handleInboundEmail } from './inbound.ts'
import { listSystemEmailMessages } from './system-email-graph-store.ts'
import { createForwardableEmailMessage } from './test-fixtures.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { buildPublishedSourceManifestSnapshotKvKey } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { exportRunRecords } from '#worker/run-records/service.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import {
	assignAdminRole,
	enableSubscriptionForOwner,
	ensurePackageSubscriptionTestSchema,
	ensureRbacTestSchema,
	seedAccount,
} from '#worker/test-support/workers-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
const platformBaseUrl = 'https://kody.example.com'
const systemDomain = 'kody.example.com'
const systemTopic = 'email.system-message.received'

async function seedSubscribedPackage(input: {
	bundleKv: Map<string, string>
	userId: string
	scope: string
}) {
	const db = env.APP_DB
	const sourceId = `source-${crypto.randomUUID()}`
	const packageId = `package-${crypto.randomUUID()}`
	const name = `@${input.scope}/system-email-notifier`
	const artifactName = `subscription:${systemTopic}`
	const artifactKey = `bundle-artifact:v1:${sourceId}:commit-1:module:${artifactName}:src/on-system-email.ts`
	const now = new Date().toISOString()
	await db.batch([
		db
			.prepare(
				`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, tags_json, search_text, source_id, has_app, created_at, updated_at
			) VALUES (?, ?, ?, 'system-email-notifier', 'System email notifier', '[]', NULL, ?, 0, ?, ?)`,
			)
			.bind(packageId, input.userId, name, sourceId, now, now),
		db
			.prepare(
				`INSERT INTO entity_sources (
				id, user_id, entity_kind, entity_id, repo_id, published_commit, indexed_commit, manifest_path, source_root, created_at, updated_at
			) VALUES (?, ?, 'package', ?, 'repo-1', 'commit-1', NULL, 'package.json', '/', ?, ?)`,
			)
			.bind(sourceId, input.userId, packageId, now, now),
		db
			.prepare(
				`INSERT INTO published_bundle_artifacts (
				id, user_id, source_id, published_commit, artifact_kind, artifact_name, entry_point, kv_key, dependencies_json, created_at, updated_at
			) VALUES (?, ?, ?, 'commit-1', 'module', ?, 'src/on-system-email.ts', ?, '[]', ?, ?)`,
			)
			.bind(
				`artifact-${crypto.randomUUID()}`,
				input.userId,
				sourceId,
				artifactName,
				artifactKey,
				now,
				now,
			),
	])

	const enablement = await enableSubscriptionForOwner({
		db: env.APP_DB,
		userId: input.userId,
		packageId,
		topic: systemTopic,
	})

	const manifest = {
		name,
		exports: { '.': './src/index.ts' },
		kody: {
			id: 'system-email-notifier',
			description: 'System email notifier',
			subscriptions: {
				[systemTopic]: { handler: './src/on-system-email.ts' },
			},
		},
	}
	input.bundleKv.set(
		buildPublishedSourceManifestSnapshotKvKey({
			sourceId,
			publishedCommit: 'commit-1',
		}),
		JSON.stringify({
			version: 1,
			sourceId,
			publishedCommit: 'commit-1',
			manifestPath: 'package.json',
			manifestContent: JSON.stringify(manifest),
			createdAt: now,
		}),
	)
	input.bundleKv.set(
		artifactKey,
		JSON.stringify({
			version: 1,
			kind: 'module',
			artifactName,
			sourceId,
			publishedCommit: 'commit-1',
			entryPoint: 'src/on-system-email.ts',
			mainModule: 'dist/subscription.js',
			modules: {
				'dist/subscription.js': `
export default async function main(input = {}) {
	return {
		event: input.event,
		messageId: input.message?.id ?? null,
		subject: input.message?.subject ?? null,
		adminUrl: input.admin_url ?? null,
	}
}
`,
			},
			dependencies: [],
			packageContext: { packageId, kodyId: 'system-email-notifier', sourceId },
			createdAt: now,
		}),
	)
	return { packageId, sourceId, enablementId: enablement.id }
}

async function seedMaxAccount(prefix: string) {
	const email = `${prefix}-${crypto.randomUUID()}@example.com`
	const accountId = await seedAccount({
		db: env.APP_DB,
		email,
		username: `${prefix}-${crypto.randomUUID().slice(0, 8)}`,
		plan: 'max',
	})
	return { accountId, stableUserId: testStableUserIdFromEmail(email) }
}

function useBundleKv(bundleKv: Map<string, string>) {
	const originalKv = env.BUNDLE_ARTIFACTS_KV
	Object.assign(env, {
		BUNDLE_ARTIFACTS_KV: {
			async get(key: string, type?: string) {
				const value = bundleKv.get(key) ?? null
				if (value == null) return null
				if (type === 'json') return JSON.parse(value) as unknown
				return value
			},
			async put() {},
			async delete() {},
		},
	})
	return {
		[Symbol.dispose]: () => {
			Object.assign(env, { BUNDLE_ARTIFACTS_KV: originalKv })
		},
	}
}

async function deliverSystemMailAndDrain(local: string, subject: string) {
	const message = createForwardableEmailMessage({
		from: 'provider@example.net',
		to: `${local}@${systemDomain}`,
		raw: [
			'From: Provider <provider@example.net>',
			`To: ${local}@${systemDomain}`,
			`Subject: ${subject}`,
			`Message-ID: <system-${crypto.randomUUID()}@example.net>`,
			'',
			'System body.',
		].join('\r\n'),
	})
	const waitUntilPromises: Array<Promise<unknown>> = []
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			waitUntilPromises.push(promise)
		},
		passThroughOnException() {},
	} as ExecutionContext
	await handleInboundEmail(
		message,
		{ ...env, APP_BASE_URL: platformBaseUrl },
		ctx,
	)
	expect(message.rejectedReason).toBeNull()
	for (const promise of waitUntilPromises) await promise
}

// Package subscription dispatch boots the real Worker Loader sandbox, which
// costs seconds per run. The shared default is 5s locally (20s in CI), so
// budget these explicitly like the other sandbox-executing suites rather than
// letting them flake under a loaded `npm run validate`.
const subscriptionDispatchTimeoutMs = 60_000

test(
	'system inbound email dispatches email.system-message.received to admin-saved packages only',
	async () => {
		// The subscription runtime warns on optional lookups (e.g. MCP server
		// refs) whose tables are not part of this test's schema.
		silenceIncidentalRuntimeWarnings()
		await ensureEmailTestSchema(env.APP_DB)
		await ensureUsageRollupsTestSchema(env.APP_DB)
		await ensurePackageSubscriptionTestSchema(env.APP_DB)
		await ensureRbacTestSchema(env.APP_DB)

		const admin = await seedMaxAccount('sysadmin')
		await assignAdminRole({ db: env.APP_DB, userId: admin.accountId })
		const adminStableId = admin.stableUserId
		const regularStableId = (await seedMaxAccount('sysuser')).stableUserId

		const bundleKv = new Map<string, string>()
		const adminPackage = await seedSubscribedPackage({
			bundleKv,
			userId: adminStableId,
			scope: 'sysadmin',
		})
		// A non-admin saving the identical subscription must never receive
		// operator system mail.
		await seedSubscribedPackage({
			bundleKv,
			userId: regularStableId,
			scope: 'sysuser',
		})
		using _kv = useBundleKv(bundleKv)

		await deliverSystemMailAndDrain('postmaster', 'Delivery report')
		const [stored] = await listSystemEmailMessages({
			db: env.APP_DB,
			limit: 1,
		})
		if (!stored) throw new Error('Expected stored system message')

		// The keyed idempotency ledger lives in each owner's RunLog DO now.
		const invocationsFor = async (userId: string) =>
			(
				await exportRunRecords({
					env,
					userId: ownerIdFromStored(userId),
					pageSize: 100,
				})
			).packageInvocations
		expect(await invocationsFor(regularStableId)).toHaveLength(0)
		const adminInvocations = await invocationsFor(adminStableId)
		expect(adminInvocations).toHaveLength(1)
		const invocation = adminInvocations[0]
		expect(invocation).toMatchObject({
			packageId: adminPackage.packageId,
			exportName: `subscription:${systemTopic}`,
			topic: systemTopic,
			source: 'email',
			idempotencyKey: `email:${stored.id}:${adminPackage.packageId}:${systemTopic}:enablement:${adminPackage.enablementId}`,
		})
		const responseJson = invocation?.responseJson
		if (!responseJson) {
			throw new Error('Expected a stored replay response for the admin row.')
		}
		expect(
			(JSON.parse(responseJson) as { body: Record<string, unknown> }).body,
		).toMatchObject({
			ok: true,
			result: {
				event: systemTopic,
				messageId: stored.id,
				subject: 'Delivery report',
				adminUrl: `${platformBaseUrl}/admin/system-email?messageId=${encodeURIComponent(stored.id)}`,
			},
		})
	},
	subscriptionDispatchTimeoutMs,
)
