import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { platformFeedbackContentWarning } from './content-warning.ts'
import { PlatformFeedbackDispatchCancelledError } from './errors.ts'
import {
	buildPlatformFeedbackSubmittedEvent,
	platformFeedbackSubmittedTopic,
} from './subscription-event.ts'
import { type PlatformFeedbackRecord } from './types.ts'

const mocks = vi.hoisted(() => ({
	getPlatformFeedbackForAdmin: vi.fn(),
	invokePackageSubscription: vi.fn(),
	listAdminStableUserIds: vi.fn(),
	listSavedPackagesByUserId: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
}))

vi.mock('#worker/identity/permissions-db.ts', () => ({
	listAdminStableUserIds: mocks.listAdminStableUserIds,
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	invokePackageSubscription: mocks.invokePackageSubscription,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: mocks.listSavedPackagesByUserId,
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
}))

vi.mock('./service.ts', () => ({
	getPlatformFeedbackForAdmin: mocks.getPlatformFeedbackForAdmin,
}))

const { dispatchPlatformFeedbackSubmittedSubscriptionEvent } =
	await import('./package-subscriptions.ts')

const openFeedback = {
	id: 'feedback-1',
	submitterUserId: 'submitter-1',
	submitterUsername: 'feedback-author',
	submitterEmail: 'feedback-author@example.com',
	category: 'friction' as const,
	summary: 'The setup path is confusing',
	details: 'The setup flow does not explain which action comes next.',
	status: 'open' as const,
	reviewedByUserId: null,
	reviewedAt: null,
	adminNote: null,
	resolutionNote: null,
	resolutionPrUrls: [],
	createdAt: '2026-07-19T00:00:00.000Z',
	updatedAt: '2026-07-19T00:00:00.000Z',
} satisfies PlatformFeedbackRecord

type SavedPackage = ReturnType<typeof pkg>

function pkg(name: string, userId = 'admin-stable-1') {
	const id = `package-${name}`
	return {
		id,
		userId,
		name: `@admin/${id}`,
		kodyId: id,
		description: `${id} notifier`,
		tags: [],
		searchText: null,
		sourceId: `source-${name}`,
		hasApp: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		createdAt: '2026-07-19T00:00:00.000Z',
		updatedAt: '2026-07-19T00:00:00.000Z',
	}
}

function createManifest(packageId: string, subscribed: boolean) {
	return {
		manifest: {
			name: `@admin/${packageId}`,
			exports: { '.': './src/index.ts' },
			kody: {
				id: packageId,
				description: `${packageId} notifier`,
				...(subscribed
					? {
							subscriptions: {
								[platformFeedbackSubmittedTopic]: {
									handler: './src/on-platform-feedback.ts',
								},
							},
						}
					: {}),
			},
		},
	}
}

function seedAdminPackages(
	byUser: Record<string, Array<SavedPackage>>,
	manifests: {
		unsubscribed?: Array<SavedPackage>
		broken?: Array<SavedPackage>
	} = {},
) {
	const all = Object.values(byUser).flat()
	mocks.listAdminStableUserIds.mockResolvedValue(Object.keys(byUser))
	mocks.listSavedPackagesByUserId.mockImplementation(
		async (_db: D1Database, input: { userId: string }) =>
			byUser[input.userId] ?? [],
	)
	mocks.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			const match = all.find((entry) => entry.sourceId === input.sourceId)
			if (!match) throw new Error(`Unexpected source id: ${input.sourceId}`)
			if (manifests.broken?.includes(match)) {
				throw new Error('manifest unavailable')
			}
			return createManifest(match.id, !manifests.unsubscribed?.includes(match))
		},
	)
}

const ok = { status: 200, body: { ok: true } }

function stubInvocations(results: Record<string, unknown>) {
	mocks.invokePackageSubscription.mockImplementation(
		async (input: { savedPackage: { id: string } }) => {
			const result = results[input.savedPackage.id] ?? ok
			if (result instanceof Error) throw result
			return result
		},
	)
}

function dispatch(feedbackId = openFeedback.id) {
	return dispatchPlatformFeedbackSubmittedSubscriptionEvent({
		env: {
			APP_DB: {} as D1Database,
			BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
			APP_BASE_URL: 'https://heykody.dev',
		},
		feedbackId,
	})
}

function invokedIds() {
	return mocks.invokePackageSubscription.mock.calls
		.map(([input]) => input.savedPackage.id as string)
		.sort()
}

test('platform feedback submitted payload contains exactly the approved event fields and encoded admin URL', () => {
	const payload = buildPlatformFeedbackSubmittedEvent({
		baseUrl: 'https://kody.example.com',
		feedback: { ...openFeedback, id: 'feedback /?#1' },
	})
	expect(payload).toEqual({
		event: 'platform.feedback.submitted',
		content_warning: platformFeedbackContentWarning,
		admin_url:
			'https://kody.example.com/admin/platform-feedback?feedbackId=feedback%20%2F%3F%231',
		feedback: {
			id: 'feedback /?#1',
			category: 'friction',
			status: 'open',
			created_at: '2026-07-19T00:00:00.000Z',
			summary_untrusted: 'The setup path is confusing',
			details_untrusted:
				'The setup flow does not explain which action comes next.',
		},
		submitter: {
			user_id: ownerIdFromStored('submitter-1'),
			username: 'feedback-author',
			email: 'feedback-author@example.com',
		},
	})
	expect(
		[payload, payload.feedback, payload.submitter].map((value) =>
			Object.keys(value).sort(),
		),
	).toEqual([
		['admin_url', 'content_warning', 'event', 'feedback', 'submitter'],
		[
			'category',
			'created_at',
			'details_untrusted',
			'id',
			'status',
			'summary_untrusted',
		],
		['email', 'user_id', 'username'],
	])
})

test('platform feedback dispatch isolates terminal handler failures and rejects after retryable or discovery failures', async () => {
	consoleWarn.mockImplementation(() => {})
	mocks.getPlatformFeedbackForAdmin.mockResolvedValue(openFeedback)
	const executionFailure = {
		status: 500,
		body: {
			ok: false,
			error: { code: 'execution_failed', message: 'Handler failed.' },
		},
	}

	const terminalOnly = pkg('terminal')
	seedAdminPackages({ 'admin-stable-1': [terminalOnly] })
	stubInvocations({ [terminalOnly.id]: executionFailure })
	await expect(dispatch()).resolves.toEqual([executionFailure])
	expect(consoleWarn).toHaveBeenCalledWith(
		'admin-package-subscription-handler-failed',
		{
			topic: platformFeedbackSubmittedTopic,
			packageId: terminalOnly.id,
			status: 500,
		},
	)

	consoleWarn.mockClear()
	mocks.invokePackageSubscription.mockClear()
	const first = pkg('first')
	const second = pkg('second')
	const broken = pkg('broken', 'admin-stable-2')
	const unrelated = pkg('unrelated', 'admin-stable-2')
	seedAdminPackages(
		{
			'admin-stable-1': [first, second],
			'admin-stable-2': [broken, unrelated],
		},
		{ unsubscribed: [unrelated], broken: [broken] },
	)
	stubInvocations({ [first.id]: executionFailure })
	await expect(dispatch()).rejects.toThrow(
		'Admin package subscription discovery failed.',
	)
	expect(invokedIds()).toEqual([first.id, second.id])
	expect(
		mocks.invokePackageSubscription.mock.calls.map(([input]) => input),
	).toEqual(
		expect.arrayContaining(
			[first, second].map((savedPackage) =>
				expect.objectContaining({
					savedPackage,
					topic: platformFeedbackSubmittedTopic,
					params: buildPlatformFeedbackSubmittedEvent({
						baseUrl: 'https://heykody.dev',
						feedback: openFeedback,
					}),
					idempotencyKey: `platform-feedback:feedback-1:${savedPackage.id}:platform.feedback.submitted`,
					source: 'platform-feedback',
					actorTokenId: 'internal:platform-feedback-subscriptions',
				}),
			),
		),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'admin-package-subscription-manifest-load-failed',
		{
			topic: platformFeedbackSubmittedTopic,
			packageId: broken.id,
			sourceId: broken.sourceId,
			error: expect.any(Error),
		},
	)
	expect(consoleWarn).toHaveBeenCalledTimes(2)

	consoleWarn.mockClear()
	mocks.invokePackageSubscription.mockClear()
	const retryable = pkg('retryable')
	const successfulSibling = pkg('successful')
	seedAdminPackages({ 'admin-stable-1': [retryable, successfulSibling] })
	stubInvocations({
		[retryable.id]: {
			status: 409,
			body: {
				ok: false,
				error: { code: 'invocation_in_progress', message: 'Please retry.' },
			},
		},
	})
	await expect(dispatch()).rejects.toThrow(
		'Admin package subscription dispatch encountered retryable package invocation infrastructure errors.',
	)
	expect(invokedIds()).toEqual([retryable.id, successfulSibling.id])
	expect(consoleWarn).toHaveBeenCalledWith(
		'admin-package-subscription-handler-failed',
		{
			topic: platformFeedbackSubmittedTopic,
			packageId: retryable.id,
			status: 409,
		},
	)
})

test('platform feedback skips lazy enrichment without admins and cancels permanently when the row is deleted', async () => {
	mocks.listAdminStableUserIds.mockResolvedValue([])
	await expect(dispatch()).resolves.toEqual([])
	expect(mocks.getPlatformFeedbackForAdmin).not.toHaveBeenCalled()

	seedAdminPackages({ 'admin-stable-1': [pkg('subscriber')] })
	mocks.getPlatformFeedbackForAdmin.mockResolvedValue(null)
	await expect(dispatch('deleted-feedback')).rejects.toBeInstanceOf(
		PlatformFeedbackDispatchCancelledError,
	)
	expect(mocks.invokePackageSubscription).not.toHaveBeenCalled()
})

test('generic admin fan-out defaults to skipping manifest and invocation failures', async () => {
	consoleWarn.mockImplementation(() => {})
	const successful = pkg('successful')
	const broken = pkg('broken')
	const thrown = pkg('thrown')
	seedAdminPackages(
		{ 'admin-stable-1': [successful, thrown, broken] },
		{ broken: [broken] },
	)
	stubInvocations({ [thrown.id]: new Error('invocation unavailable') })

	await expect(
		dispatchAdminPackageSubscriptionEvent({
			env: {
				APP_DB: {} as D1Database,
				BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
			},
			baseUrl: 'https://heykody.dev',
			topic: platformFeedbackSubmittedTopic,
			getParams: () => ({}),
			source: 'test',
			buildIdempotencyKey: (savedPackage) => `test:${savedPackage.id}`,
		}),
	).resolves.toEqual([ok, null])
	expect(invokedIds()).toEqual([successful.id, thrown.id])
	expect(consoleWarn).toHaveBeenCalledWith(
		'admin-package-subscription-manifest-load-failed',
		expect.objectContaining({ packageId: broken.id }),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'admin-package-subscription-invocation-failed',
		expect.objectContaining({ packageId: thrown.id }),
	)
})
