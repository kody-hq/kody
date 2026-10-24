import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createSubscriptionDiscoverySourceMocks } from '#worker/test-support/package-subscription-source-mocks.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import type * as PackageInvocationsService from '#worker/package-invocations/service.ts'

const mocks = vi.hoisted(() => ({
	invokePackageSubscription: vi.fn<
		typeof PackageInvocationsService.invokePackageSubscription
	>(async () => ({ status: 200, body: {} })),
	listSavedPackagesByUserId: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
	findIntegrationCredentialId: vi.fn(async () => 'cred-google'),
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	invokePackageSubscription: mocks.invokePackageSubscription,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: mocks.listSavedPackagesByUserId,
}))

vi.mock('#worker/package-registry/source.ts', () =>
	createSubscriptionDiscoverySourceMocks(mocks.loadPackageManifestBySourceId),
)

vi.mock('#worker/integrations/credentials.ts', () => ({
	findIntegrationCredentialId: mocks.findIntegrationCredentialId,
}))

const {
	buildIntegrationAuthFailedReconnectUrl,
	dispatchIntegrationAuthFailedSubscriptionEvents,
	dispatchIntegrationAuthSucceededSubscriptionEvents,
	integrationAuthFailedTopic,
	integrationAuthSucceededTopic,
} = await import('./package-subscriptions.ts')

const env = {
	APP_DB: {},
	BUNDLE_ARTIFACTS_KV: {},
	APP_BASE_URL: 'https://example.com',
} as Env

function pkg(index: number, kodyId: string) {
	return {
		id: `package-${index}`,
		userId: ownerIdFromStored('user-1'),
		orgSlug: 'ada',
		sourceId: `source-${index}`,
		kodyId,
		name: `@user/${kodyId}`,
	}
}

function subscribedManifest(
	kodyId: string,
	topic: string = integrationAuthFailedTopic,
	handler = './src/on-integration-auth-failed.ts',
) {
	return {
		manifest: {
			name: `@user/${kodyId}`,
			kody: {
				id: kodyId,
				description: 'Auth notifier',
				subscriptions: { [topic]: { handler } },
			},
		},
	}
}

const workIntegration = {
	name: 'google',
	lane: 'platform' as const,
	account_label: 'Work',
	description: 'Personal Gmail',
	provider: 'google',
	platform_app_slug: 'google',
	connected_at: '2026-01-01T00:00:00.000Z',
	token_refreshed_at: '2026-08-01T00:00:00.000Z',
}

const bareIntegration = {
	name: 'google',
	account_label: null,
	description: null,
	provider: 'google',
	scopes: [],
	connected_at: null,
	token_refreshed_at: null,
}

function expectNoSecretParams(extra: Array<string> = []) {
	const params = mocks.invokePackageSubscription.mock.calls[0]?.[0]
		?.params as Record<string, unknown>
	expect(
		['access_token', 'refresh_token', 'client_secret', ...extra].filter(
			(key) => key in params,
		),
	).toEqual([])
}

test('reconnect URLs add loginHint only when the account label is an email', () => {
	const cases: Array<[string, string | undefined, string]> = [
		['google', undefined, 'provider=google'],
		['google-business', 'Work', 'provider=google-business'],
		[
			'google',
			'kent.c.dodds@gmail.com',
			'provider=google&loginHint=kent.c.dodds%40gmail.com',
		],
	]
	for (const [integrationName, accountLabel, query] of cases) {
		expect(
			buildIntegrationAuthFailedReconnectUrl({
				baseUrl: 'https://example.com',
				integrationName,
				...(accountLabel ? { accountLabel } : {}),
			}),
		).toBe(`https://example.com/connect/oauth?${query}`)
	}
})

test('integration.auth.failed fans out only to owning-user packages with a lean payload', async () => {
	const savedPackage = pkg(1, 'auth-notifier')
	mocks.listSavedPackagesByUserId.mockResolvedValueOnce([savedPackage])
	mocks.loadPackageManifestBySourceId.mockResolvedValueOnce(
		subscribedManifest('auth-notifier'),
	)
	const integration = {
		...workIntegration,
		scopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar'],
	}
	const provider = {
		error: 'invalid_grant',
		error_description: 'Token has been expired or revoked.',
		http_status: 400,
	}
	const results = await dispatchIntegrationAuthFailedSubscriptionEvents({
		env,
		userId: ownerIdFromStored('user-1'),
		orgSlug: 'ada',
		eventId: 'event-1',
		occurredAt: '2026-08-18T17:00:00.000Z',
		integration,
		reason: 'provider_rejected',
		provider,
	})

	expect(results).toHaveLength(1)
	expect(mocks.listSavedPackagesByUserId).toHaveBeenCalledWith(env.APP_DB, {
		userId: ownerIdFromStored('user-1'),
	})
	expect(mocks.invokePackageSubscription).toHaveBeenCalledWith(
		expect.objectContaining({
			savedPackage,
			topic: integrationAuthFailedTopic,
			idempotencyKey: `integration-auth-failed:event-1:package-1`,
			source: 'integrations',
			params: {
				event: integrationAuthFailedTopic,
				event_id: 'event-1',
				integration,
				reason: 'provider_rejected',
				provider,
				reconnect_url: 'https://example.com/connect/oauth?provider=google',
				account_url: 'https://example.com/@ada/-/integrations/google',
				occurred_at: '2026-08-18T17:00:00.000Z',
			},
		}),
	)
	expectNoSecretParams()
})

test('integration.auth.failed never throws on discovery or handler failures', async () => {
	consoleWarn.mockImplementation(() => {})
	const discoveryIncomplete =
		'integration.auth.failed package subscription discovery incomplete'
	mocks.listSavedPackagesByUserId.mockRejectedValueOnce(
		new Error('D1 unavailable'),
	)
	await expect(
		dispatchIntegrationAuthFailedSubscriptionEvents({
			env,
			userId: ownerIdFromStored('user-1'),
			orgSlug: 'ada',
			eventId: 'event-2',
			occurredAt: '2026-08-18T17:00:00.000Z',
			integration: {
				...bareIntegration,
				lane: 'user',
				platform_app_slug: null,
			},
			reason: 'missing_refresh_token',
			provider: { error: null, error_description: null, http_status: null },
		}),
	).resolves.toEqual([])
	expect(mocks.invokePackageSubscription).not.toHaveBeenCalled()
	expect(consoleWarn).toHaveBeenCalledWith(
		discoveryIncomplete,
		expect.objectContaining({
			eventId: 'event-2',
			integrationName: 'google',
			errorCount: 1,
		}),
	)
	expect(
		consoleWarn.mock.calls.find((call) => call[0] === discoveryIncomplete)?.[1],
	).not.toHaveProperty('userId')

	mocks.listSavedPackagesByUserId.mockResolvedValueOnce([
		pkg(1, 'auth-notifier'),
		pkg(2, 'broken'),
		pkg(3, 'notifier-b'),
	])
	mocks.loadPackageManifestBySourceId
		.mockResolvedValueOnce(subscribedManifest('auth-notifier'))
		.mockRejectedValueOnce(new Error('manifest unavailable'))
		.mockResolvedValueOnce(subscribedManifest('notifier-b'))
	mocks.invokePackageSubscription
		.mockRejectedValueOnce(new Error('handler boom'))
		.mockResolvedValueOnce({ status: 200, body: { ok: true } })
	await expect(
		dispatchIntegrationAuthFailedSubscriptionEvents({
			env,
			userId: ownerIdFromStored('user-1'),
			orgSlug: 'ada',
			eventId: 'event-3',
			occurredAt: '2026-08-18T17:00:00.000Z',
			integration: {
				...bareIntegration,
				lane: 'platform',
				platform_app_slug: 'google',
			},
			reason: 'provider_rejected',
			provider: {
				error: 'invalid_grant',
				error_description: null,
				http_status: 400,
			},
		}),
	).resolves.toEqual([null, { status: 200, body: { ok: true } }])
	expect(mocks.invokePackageSubscription).toHaveBeenCalledTimes(2)
	expect(consoleWarn).toHaveBeenCalledWith(
		'integration.auth.failed package subscription invoke failed',
		expect.objectContaining({ eventId: 'event-3', error: expect.any(Error) }),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'admin-package-subscription-manifest-load-failed',
		expect.objectContaining({ packageId: 'package-2' }),
	)
})

test('integration.auth.succeeded fans out a lean payload only to packages on that topic', async () => {
	const savedPackage = pkg(1, 'auth-notifier')
	mocks.listSavedPackagesByUserId.mockResolvedValueOnce([
		savedPackage,
		pkg(2, 'failed-only'),
	])
	mocks.loadPackageManifestBySourceId
		.mockResolvedValueOnce(
			subscribedManifest(
				'auth-notifier',
				integrationAuthSucceededTopic,
				'./src/on-event.ts',
			),
		)
		.mockResolvedValueOnce(subscribedManifest('failed-only'))
	const integration = { ...workIntegration, scopes: ['openid', 'email'] }

	const results = await dispatchIntegrationAuthSucceededSubscriptionEvents({
		env,
		userId: ownerIdFromStored('user-1'),
		orgSlug: 'ada',
		eventId: 'event-4',
		occurredAt: '2026-08-18T18:00:00.000Z',
		integration,
		source: 'refresh',
	})
	expect(results).toHaveLength(1)
	expect(mocks.invokePackageSubscription).toHaveBeenCalledTimes(1)
	expect(mocks.invokePackageSubscription).toHaveBeenCalledWith(
		expect.objectContaining({
			savedPackage,
			topic: integrationAuthSucceededTopic,
			idempotencyKey: `integration-auth-succeeded:event-4:package-1`,
			source: 'integrations',
			params: {
				event: integrationAuthSucceededTopic,
				event_id: 'event-4',
				integration,
				source: 'refresh',
				account_url: 'https://example.com/@ada/-/integrations/google',
				occurred_at: '2026-08-18T18:00:00.000Z',
			},
		}),
	)
	expectNoSecretParams(['reconnect_url'])
})
