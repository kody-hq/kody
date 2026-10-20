import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { createExecuteExecutor } from './executor.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { usageEventDoubleIndexes } from '#worker/usage/record-usage.ts'

type FakeWorkerOptions = Record<string, unknown>

function createFakeWorkerLoader() {
	const createdOptions = new Map<string, FakeWorkerOptions>()
	const loader = {
		get(id: string, factory: () => FakeWorkerOptions) {
			let options = createdOptions.get(id)
			if (!options) {
				options = factory()
				createdOptions.set(id, options)
			}
			return {
				getEntrypoint() {
					return {
						async evaluate() {
							return { result: id, logs: [] }
						},
					}
				},
			}
		},
	} as unknown as Env['LOADER']
	return {
		loader,
		createdOptions,
		get ids() {
			return [...createdOptions.keys()]
		},
	}
}

function createExecutorTestEnv(loader: Env['LOADER']) {
	return {
		LOADER: loader,
		APP_COMMIT_SHA: 'commit-for-test',
	} as Env
}

const gatewayExports = {
	KodyFetchGateway: ({ props }: { props: unknown }) => ({ props }),
}
const providers = [{ name: 'kody', fns: {} }]

function createGatewayProps(userId: string) {
	return {
		baseUrl: 'https://heykody.dev',
		userId: ownerIdFromStored(userId),
		email: `${userId}@example.com`,
		request: null,
		storageContext: null,
	}
}

test('createExecuteExecutor records privacy-safe Dynamic Worker reuse on every LOADER invoke', async () => {
	const dataPoints: Array<AnalyticsEngineDataPoint> = []
	const meter = createInMemoryUserMeterEnv()
	const usageBindings = {
		...meter.env,
		USAGE_EVENTS: {
			writeDataPoint(point?: AnalyticsEngineDataPoint) {
				if (point) dataPoints.push(point)
			},
		},
	}
	const sourceMarker = 'UNIQUE_SOURCE_MARKER_reuse_metrics'
	const paramMarker = 'UNIQUE_PARAM_MARKER_reuse_metrics'
	const source = `async () => "${sourceMarker}"`
	const invokes = () =>
		dataPoints.filter((point) => point.blobs?.[1] === 'dynamic_worker_invoke')
	const runJob = async (
		invocation: { params?: unknown } | undefined,
		executeShape?: 'glue',
	) =>
		await createExecuteExecutor({
			env: {
				...createExecutorTestEnv(createFakeWorkerLoader().loader),
				...usageBindings,
			} as Env,
			exports: gatewayExports as never,
			gatewayProps: createGatewayProps('usage-user-reuse'),
			recordExecuteUsage: false,
			surface: 'job',
			...(executeShape ? { executeShape } : {}),
		}).execute(source, providers, invocation)

	await runJob({ params: { token: paramMarker } }, 'glue')
	const miss = invokes()[0]
	expect(miss?.blobs?.slice(5)).toEqual([
		'job',
		'glue',
		'miss',
		'',
		'usage-user-reuse',
		'',
		'',
		'',
	])
	expect(miss?.blobs).toHaveLength(13)
	expect(miss?.doubles?.[0]).toBeGreaterThanOrEqual(0)
	expect(miss?.doubles?.[3]).toBeGreaterThan(0)
	expect(miss?.doubles?.[usageEventDoubleIndexes.paramsChars]).toBeGreaterThan(
		0,
	)

	await runJob({ params: { token: `${paramMarker}-2` } }, 'glue')
	const hit = invokes()[1]
	expect(invokes()).toHaveLength(2)
	expect(hit?.blobs?.[7]).toBe('hit')
	expect(hit?.blobs).toHaveLength(13)
	expect(hit?.doubles?.[3]).toBe(miss?.doubles?.[3])
	expect(hit?.doubles?.[usageEventDoubleIndexes.paramsChars]).toBeGreaterThan(0)

	for (const params of [undefined, {}, null, 'not-an-object', [1, 2]]) {
		await runJob(params === undefined ? undefined : { params })
		expect(dataPoints.at(-1)?.blobs?.[1]).toBe('dynamic_worker_invoke')
		expect(dataPoints.at(-1)?.blobs).toHaveLength(13)
		expect(
			dataPoints.at(-1)?.doubles?.[usageEventDoubleIndexes.paramsChars],
		).toBe(0)
	}
	expect(invokes()).toHaveLength(7)

	const serialized = JSON.stringify(dataPoints)
	for (const secret of [
		sourceMarker,
		paramMarker,
		source,
		'token',
		'not-an-object',
	]) {
		expect(serialized).not.toContain(secret)
	}
})

test('createExecuteExecutor attaches the CPU usage tail under its own loader cache id', async () => {
	const runWith = async (
		extraEnv: Record<string, unknown>,
		exports: Record<string, unknown>,
	) => {
		const fake = createFakeWorkerLoader()
		await createExecuteExecutor({
			env: { ...createExecutorTestEnv(fake.loader), ...extraEnv } as Env,
			exports: exports as never,
			gatewayProps: createGatewayProps('user-1'),
		}).execute('async () => "ok"', providers)
		const id = fake.ids[0]!
		return { id, tails: fake.createdOptions.get(id)?.tails }
	}

	const withoutTail = await runWith({}, gatewayExports)
	expect(withoutTail.tails).toBeUndefined()

	// Without Analytics Engine (local dev, tests) no tail is attached.
	const unbound = await runWith(
		{},
		{
			...gatewayExports,
			DynamicWorkerUsageTail: ({ props }: { props: unknown }) => ({ props }),
		},
	)
	expect(unbound.id).toBe(withoutTail.id)

	const withTail = await runWith(
		{ USAGE_EVENTS: { writeDataPoint() {} } },
		{
			...gatewayExports,
			DynamicWorkerUsageTail: ({ props }: { props: unknown }) => ({
				tailProps: props,
			}),
		},
	)
	expect(withTail).toEqual({
		id: `${withoutTail.id}-cpu1`,
		tails: [
			{
				tailProps: {
					userId: ownerIdFromStored('user-1'),
					workerId: withoutTail.id,
				},
			},
		],
	})
})
