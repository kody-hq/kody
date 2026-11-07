import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import type { PackageAppCpuSample } from '#universal/package-app-cpu-samples.ts'
import type { RunLog } from './run-log-do.ts'

function runLogStub(label: string) {
	const namespace = env.RUN_LOG as DurableObjectNamespace<RunLog>
	return namespace.get(
		namespace.idFromName(
			ownerIdFromStored(`runlog-cpu-${label}-${crypto.randomUUID()}`),
		),
	)
}

function sample(
	overrides: Partial<PackageAppCpuSample> & { requestId: string },
): PackageAppCpuSample {
	return {
		occurredAt: new Date().toISOString(),
		packageId: 'pkg-1',
		packageName: 'my-app',
		cold: false,
		cpuMs: 3,
		wallMs: 30,
		path: '/',
		status: 200,
		outcome: 'ok',
		...overrides,
	}
}

test('RunLog stores sampled package-app CPU and prunes past retention', async () => {
	const stub = runLogStub('retention')
	await stub.recordPackageAppCpuSample(
		sample({
			requestId: 'old',
			occurredAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
			cold: true,
			wallMs: 9_000,
		}),
	)
	await stub.recordPackageAppCpuSample(
		sample({ requestId: 'warm', cpuMs: 2, wallMs: 20 }),
	)
	await stub.recordPackageAppCpuSample(
		sample({ requestId: 'cold', cold: true, cpuMs: 40, wallMs: 800 }),
	)
	// Same request id twice (tail redelivery) is stored once.
	await stub.recordPackageAppCpuSample(
		sample({ requestId: 'cold', cold: true, cpuMs: 40, wallMs: 800 }),
	)
	const summary = await stub.packageAppCpuSummary()
	expect(summary.apps).toEqual([
		expect.objectContaining({
			packageId: 'pkg-1',
			samples: 2,
			coldSamples: 1,
			cpuP95Ms: 40,
			wallP50Ms: 20,
		}),
	])
	expect(summary.slowColdRequests.map((entry) => entry.requestId)).toEqual([
		'cold',
	])
})
