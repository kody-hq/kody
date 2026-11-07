/**
 * Sampled CPU and wall time for package-app requests, shown to owners on
 * Activity. Observability only: never billed and never counted toward plan
 * limits or entitlements.
 */

/** Every cold request is sampled; warm requests at this rate. */
export const packageAppWarmCpuSampleRate = 0.05

/** Samples older than this are deleted. */
export const packageAppCpuSampleRetentionDays = 7

/** Newest samples kept per account; older ones are deleted first. */
export const packageAppCpuSampleMaxRows = 5_000

/** Slow cold requests listed on Activity. */
export const packageAppSlowColdRequestLimit = 10

export type PackageAppCpuSample = {
	/** Matches the `x-kody-request-id` response header. */
	requestId: string
	occurredAt: string
	packageId: string
	packageName: string | null
	cold: boolean
	cpuMs: number
	wallMs: number
	/** Path only, never the query string. */
	path: string | null
	status: number | null
	outcome: 'ok' | 'error'
}

export type PackageAppCpuPercentiles = {
	samples: number
	coldSamples: number
	cpuP50Ms: number
	cpuP95Ms: number
	wallP50Ms: number
	wallP95Ms: number
}

export type PackageAppCpuAppSummary = PackageAppCpuPercentiles & {
	packageId: string
	packageName: string | null
}

export type PackageAppCpuSummary = {
	since: string
	retentionDays: number
	warmSampleRate: number
	apps: Array<PackageAppCpuAppSummary>
	slowColdRequests: Array<PackageAppCpuSample>
}

/** Nearest-rank percentile of `values` (any order). 0 when empty. */
export function percentileMs(values: Array<number>, percentile: number) {
	if (values.length === 0) return 0
	const sorted = [...values].sort((a, b) => a - b)
	const rank = Math.ceil((percentile / 100) * sorted.length)
	return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0
}

export function summarizePackageAppCpuSamples(input: {
	since: string
	samples: Array<PackageAppCpuSample>
}): PackageAppCpuSummary {
	const byPackage = new Map<string, Array<PackageAppCpuSample>>()
	for (const sample of input.samples) {
		const list = byPackage.get(sample.packageId) ?? []
		list.push(sample)
		byPackage.set(sample.packageId, list)
	}
	const apps = [...byPackage.entries()].map(([packageId, samples]) => ({
		packageId,
		packageName:
			samples.find((sample) => sample.packageName)?.packageName ?? null,
		samples: samples.length,
		coldSamples: samples.filter((sample) => sample.cold).length,
		cpuP50Ms: percentileMs(
			samples.map((sample) => sample.cpuMs),
			50,
		),
		cpuP95Ms: percentileMs(
			samples.map((sample) => sample.cpuMs),
			95,
		),
		wallP50Ms: percentileMs(
			samples.map((sample) => sample.wallMs),
			50,
		),
		wallP95Ms: percentileMs(
			samples.map((sample) => sample.wallMs),
			95,
		),
	}))
	apps.sort(
		(a, b) =>
			b.cpuP95Ms - a.cpuP95Ms ||
			b.samples - a.samples ||
			a.packageId.localeCompare(b.packageId),
	)
	const slowColdRequests = input.samples
		.filter((sample) => sample.cold)
		.sort(
			(a, b) =>
				b.wallMs - a.wallMs ||
				b.cpuMs - a.cpuMs ||
				b.occurredAt.localeCompare(a.occurredAt),
		)
		.slice(0, packageAppSlowColdRequestLimit)
	return {
		since: input.since,
		retentionDays: packageAppCpuSampleRetentionDays,
		warmSampleRate: packageAppWarmCpuSampleRate,
		apps,
		slowColdRequests,
	}
}
