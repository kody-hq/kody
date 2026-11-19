import {
	applyD1Migrations,
	createExecutionContext,
	env,
	waitOnExecutionContext,
	type D1Migration,
} from 'cloudflare:test'
import { beforeAll, expect, test, vi } from 'vitest'
import runtimeWorker from '#worker/runtime-worker.ts'
import { packageAppLegacyMountEventKind } from '#worker/package-runtime/package-app-legacy-mount.ts'

const testEnv = env as typeof env & { TEST_MIGRATIONS: Array<D1Migration> }

beforeAll(async () => {
	await applyD1Migrations(testEnv.APP_DB, testEnv.TEST_MIGRATIONS)
})

// `kody-runtime` serves every `{username}.kody.run` request, so the legacy
// `/packages/{name}` counter must be written through its own binding.
test('the runtime Worker records legacy /packages hits through PACKAGE_APP_LEGACY_EVENTS', async () => {
	const writeDataPoint = vi.fn()
	const runtimeEnv = {
		...testEnv,
		APP_BASE_URL: 'https://app.kody.test',
		PACKAGE_APP_BASE_URL: 'https://packages.isolated.test',
		SENTRY_ENVIRONMENT: 'production',
		PACKAGE_APP_LEGACY_EVENTS: { writeDataPoint },
	} as unknown as Env
	const ctx = createExecutionContext()

	const response = await runtimeWorker.fetch!(
		new Request(
			'https://legacy-owner.packages.isolated.test/packages/demo/report?tab=1',
			{
				headers: { Accept: 'text/html' },
				redirect: 'manual',
			},
		) as Request<unknown, IncomingRequestCfProperties>,
		runtimeEnv,
		ctx,
	)
	await waitOnExecutionContext(ctx)

	expect(response.status).toBe(308)
	expect(response.headers.get('Location')).toBe('/demo/report?tab=1')
	expect(writeDataPoint).toHaveBeenCalledExactlyOnceWith({
		indexes: ['legacy-owner'],
		blobs: [
			packageAppLegacyMountEventKind,
			'legacy-owner',
			'demo',
			'GET',
			'redirect',
		],
		doubles: [1],
	})
})
