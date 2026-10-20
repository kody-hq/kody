import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
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
import { platformFeedbackContentWarning } from './content-warning.ts'
import { dispatchPlatformFeedbackSubmittedSubscriptionEvent } from './package-subscriptions.ts'
import {
	buildPlatformFeedbackSubmittedEvent,
	platformFeedbackSubmittedTopic,
} from './subscription-event.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
const platformBaseUrl = 'https://kody.example.com'

const openFeedback = {
	id: 'feedback-integration-1',
	submitterUserId: 'submitter-integration-1',
	submitterUsername: 'feedback-submitter',
	submitterEmail: 'feedback-submitter@example.com',
	category: 'suggestion' as const,
	summary: 'Make subscription failures easier to inspect',
	details: 'Include enough approved context in the admin notification.',
	status: 'open' as const,
	reviewedByUserId: null,
	reviewedAt: null,
	adminNote: null,
	resolutionNote: null,
	resolutionPrUrls: [] as Array<string>,
	createdAt: '2026-07-19T01:00:00.000Z',
	updatedAt: '2026-07-19T01:00:00.000Z',
}

async function ensurePlatformFeedbackTestSchema(db: D1Database) {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS platform_feedback (
				id TEXT PRIMARY KEY NOT NULL,
				submitter_user_id TEXT NOT NULL,
				submitter_username TEXT,
				submitter_email TEXT,
				category TEXT NOT NULL,
				summary TEXT NOT NULL,
				details TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'open',
				reviewed_by_user_id TEXT,
				reviewed_at TEXT,
				admin_note TEXT,
				resolution_note TEXT,
				resolution_pr_urls TEXT,
				revision INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
		)
		.run()
}

async function seedUser(prefix: string) {
	const email = `${prefix}-${crypto.randomUUID()}@example.com`
	const username = `${prefix.replace(/-/g, '')}-${crypto.randomUUID().slice(0, 8)}`
	const stableId = testStableUserIdFromEmail(email)
	const accountId = await seedAccount({ db: env.APP_DB, email, username })
	return { email, username, stableId, accountId }
}

function dispatch(feedbackId: string) {
	return dispatchPlatformFeedbackSubmittedSubscriptionEvent({
		env: { ...env, APP_BASE_URL: platformBaseUrl },
		feedbackId,
	})
}

async function seedSubscribedPackage(input: {
	bundleKv: Map<string, string>
	userId: string
	scope: string
	suffix: string
	expectedPayload: unknown
}) {
	const db = env.APP_DB
	const sourceId = `source-${crypto.randomUUID()}`
	const packageId = `package-${crypto.randomUUID()}`
	const kodyId = `platform-feedback-notifier-${input.suffix}`
	const now = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, tags_json, search_text, source_id, has_app, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, '[]', NULL, ?, 0, ?, ?)`,
		)
		.bind(
			packageId,
			input.userId,
			`@${input.scope}/${kodyId}`,
			kodyId,
			'Platform feedback notifier',
			sourceId,
			now,
			now,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO entity_sources (
				id, user_id, entity_kind, entity_id, repo_id, published_commit, indexed_commit, manifest_path, source_root, created_at, updated_at
			) VALUES (?, ?, 'package', ?, 'repo-1', 'commit-1', NULL, 'package.json', '/', ?, ?)`,
		)
		.bind(sourceId, input.userId, packageId, now, now)
		.run()

	const enablement = await enableSubscriptionForOwner({
		db: env.APP_DB,
		userId: input.userId,
		packageId,
		topic: platformFeedbackSubmittedTopic,
	})

	const manifest = {
		name: `@${input.scope}/${kodyId}`,
		exports: {
			'.': './src/index.ts',
		},
		kody: {
			id: kodyId,
			description: 'Platform feedback notifier',
			subscriptions: {
				[platformFeedbackSubmittedTopic]: {
					handler: './src/on-platform-feedback.ts',
				},
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

	const expectedPayloadJson = JSON.stringify(input.expectedPayload)
	const subscriptionArtifact = {
		version: 1,
		kind: 'module',
		artifactName: `subscription:${platformFeedbackSubmittedTopic}`,
		sourceId,
		publishedCommit: 'commit-1',
		entryPoint: 'src/on-platform-feedback.ts',
		mainModule: 'dist/subscription.js',
		modules: {
			'dist/subscription.js': `
const expectedPayload = ${expectedPayloadJson}

export default async function main(input = {}) {
	return {
		payloadMatches: JSON.stringify(input) === JSON.stringify(expectedPayload),
		event: input.event ?? null,
		feedbackId: input.feedback?.id ?? null,
		summaryUntrusted: input.feedback?.summary_untrusted ?? null,
		detailsUntrusted: input.feedback?.details_untrusted ?? null,
		submitter: input.submitter ?? null,
		adminUrl: input.admin_url ?? null,
		contentWarning: input.content_warning ?? null,
		hasDeniedFields: [
			'admin_note',
			'reviewed_by_user_id',
			'reviewed_at',
			'revision',
			'updated_at',
			'roles',
			'plan',
		].some((field) =>
			Object.prototype.hasOwnProperty.call(input, field) ||
			Object.prototype.hasOwnProperty.call(input.feedback ?? {}, field) ||
			Object.prototype.hasOwnProperty.call(input.submitter ?? {}, field)
		),
	}
}
`,
		},
		dependencies: [],
		packageContext: {
			packageId,
			kodyId,
			sourceId,
		},
		createdAt: now,
	}
	const artifactKey = `bundle-artifact:v1:${sourceId}:commit-1:module:subscription:${platformFeedbackSubmittedTopic}:src/on-platform-feedback.ts`
	input.bundleKv.set(artifactKey, JSON.stringify(subscriptionArtifact))
	await db
		.prepare(
			`INSERT INTO published_bundle_artifacts (
				id, user_id, source_id, published_commit, artifact_kind, artifact_name, entry_point, kv_key, dependencies_json, created_at, updated_at
			) VALUES (?, ?, ?, 'commit-1', 'module', ?, 'src/on-platform-feedback.ts', ?, '[]', ?, ?)`,
		)
		.bind(
			`artifact-${crypto.randomUUID()}`,
			input.userId,
			sourceId,
			`subscription:${platformFeedbackSubmittedTopic}`,
			artifactKey,
			now,
			now,
		)
		.run()
	return { packageId, enablementId: enablement.id }
}

// Package subscription dispatch boots the real Worker Loader sandbox, which
// costs seconds per run. The shared default is 5s locally (20s in CI), so
// budget these explicitly like the other sandbox-executing suites rather than
// letting them flake under a loaded `npm run validate`.
const subscriptionDispatchTimeoutMs = 60_000

test(
	'platform feedback dispatch keeps stored identity snapshots idempotent across live account changes and reaches only admin subscribers',
	async () => {
		silenceIncidentalRuntimeWarnings()
		await ensurePackageSubscriptionTestSchema(env.APP_DB)
		await ensurePlatformFeedbackTestSchema(env.APP_DB)
		await ensureRbacTestSchema(env.APP_DB)

		const submitter = await seedUser('feedback-submitter')
		const dispatchFeedback = {
			...openFeedback,
			submitterUserId: submitter.stableId,
			submitterUsername: submitter.username,
			submitterEmail: submitter.email,
		}
		await env.APP_DB.prepare(
			`INSERT OR REPLACE INTO platform_feedback (
			id, submitter_user_id, submitter_username, submitter_email,
			category, summary, details, status, reviewed_by_user_id,
			reviewed_at, admin_note, revision, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?)`,
		)
			.bind(
				dispatchFeedback.id,
				dispatchFeedback.submitterUserId,
				dispatchFeedback.submitterUsername,
				dispatchFeedback.submitterEmail,
				dispatchFeedback.category,
				dispatchFeedback.summary,
				dispatchFeedback.details,
				dispatchFeedback.status,
				dispatchFeedback.createdAt,
				dispatchFeedback.updatedAt,
			)
			.run()

		const admin = await seedUser('feedback-admin')
		await assignAdminRole({ db: env.APP_DB, userId: admin.accountId })
		const adminStableId = admin.stableId
		const regularStableId = (await seedUser('feedback-user')).stableId

		const bundleKv = new Map<string, string>()
		const expectedPayload = buildPlatformFeedbackSubmittedEvent({
			baseUrl: platformBaseUrl,
			feedback: dispatchFeedback,
		})
		const seedPackage = (userId: string, scope: string, suffix: string) =>
			seedSubscribedPackage({
				bundleKv,
				userId,
				scope,
				suffix,
				expectedPayload,
			})
		const firstAdminPackage = await seedPackage(
			adminStableId,
			'feedbackadmin',
			'first',
		)
		const secondAdminPackage = await seedPackage(
			adminStableId,
			'feedbackadmin',
			'second',
		)
		const regularPackage = await seedPackage(
			regularStableId,
			'feedbackuser',
			'regular',
		)

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

		try {
			await dispatch(dispatchFeedback.id)
			await env.APP_DB.prepare(
				`UPDATE users SET username = ?, email = ? WHERE id = ?`,
			)
				.bind(
					`changed-${crypto.randomUUID().slice(0, 8)}`,
					`changed-${crypto.randomUUID()}@example.com`,
					submitter.accountId,
				)
				.run()
			await dispatch(dispatchFeedback.id)

			// The keyed idempotency ledger lives in each owner's RunLog DO now.
			const adminInvocations = (
				await exportRunRecords({
					env,
					userId: ownerIdFromStored(adminStableId),
					pageSize: 100,
				})
			).packageInvocations
			const regularInvocations = (
				await exportRunRecords({
					env,
					userId: ownerIdFromStored(regularStableId),
					pageSize: 100,
				})
			).packageInvocations
			expect(adminInvocations).toHaveLength(2)
			for (const adminPackage of [firstAdminPackage, secondAdminPackage]) {
				const invocation = adminInvocations.find(
					(row) => row.packageId === adminPackage.packageId,
				)
				expect(invocation).toMatchObject({
					packageId: adminPackage.packageId,
					tokenId: 'internal:platform-feedback-subscriptions',
					exportName: `subscription:${platformFeedbackSubmittedTopic}`,
					topic: platformFeedbackSubmittedTopic,
					source: 'platform-feedback',
					idempotencyKey: `platform-feedback:${dispatchFeedback.id}:${adminPackage.packageId}:${platformFeedbackSubmittedTopic}:enablement:${adminPackage.enablementId}`,
				})
				const responseJson = invocation?.responseJson
				if (!responseJson) {
					throw new Error(
						'Expected a stored replay response for the admin row.',
					)
				}
				const response = JSON.parse(responseJson) as {
					body: Record<string, unknown>
				}
				expect(response.body).toMatchObject({
					ok: true,
					result: {
						payloadMatches: true,
						event: platformFeedbackSubmittedTopic,
						feedbackId: dispatchFeedback.id,
						summaryUntrusted: dispatchFeedback.summary,
						detailsUntrusted: dispatchFeedback.details,
						submitter: {
							user_id: submitter.stableId,
							username: submitter.username,
							email: submitter.email,
						},
						adminUrl: `${platformBaseUrl}/admin/platform-feedback?feedbackId=${dispatchFeedback.id}`,
						contentWarning: platformFeedbackContentWarning,
						hasDeniedFields: false,
					},
				})
			}
			// Nothing may reach the non-admin subscriber's ledger.
			expect(regularInvocations).toHaveLength(0)
			expect(
				adminInvocations.some(
					(row) => row.packageId === regularPackage.packageId,
				),
			).toBe(false)

			const countInvocations = async () => {
				const pages = await Promise.all(
					[adminStableId, regularStableId].map((userId) =>
						exportRunRecords({
							env,
							userId: ownerIdFromStored(userId),
							pageSize: 100,
						}),
					),
				)
				return pages.reduce(
					(total, page) => total + page.packageInvocations.length,
					0,
				)
			}
			await env.APP_DB.prepare(`DELETE FROM user_roles`).run()
			const before = await countInvocations()
			expect(await dispatch('feedback-without-admins')).toEqual([])
			expect(await countInvocations()).toBe(before)

			await env.APP_DB.prepare(`DROP TABLE user_roles`).run()
			await env.APP_DB.prepare(`DROP TABLE roles`).run()
			expect(await dispatch('feedback-before-rbac')).toEqual([])
			expect(await countInvocations()).toBe(before)
		} finally {
			Object.assign(env, { BUNDLE_ARTIFACTS_KV: originalKv })
		}
	},
	subscriptionDispatchTimeoutMs,
)
