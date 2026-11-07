import {
	packageAppCpuSampleMaxRows,
	packageAppCpuSampleRetentionDays,
	summarizePackageAppCpuSamples,
	type PackageAppCpuSample,
	type PackageAppCpuSummary,
} from '#universal/package-app-cpu-samples.ts'

export function initializePackageAppCpuSamples(sql: SqlStorage) {
	sql.exec(`CREATE TABLE IF NOT EXISTS package_app_cpu_samples (
  request_id TEXT PRIMARY KEY NOT NULL,
  occurred_at TEXT NOT NULL,
  package_id TEXT NOT NULL,
  sample_json TEXT NOT NULL
 )`)
	sql.exec(
		'CREATE INDEX IF NOT EXISTS package_app_cpu_samples_time ON package_app_cpu_samples(occurred_at)',
	)
}

function retentionCutoff(now: Date) {
	return new Date(
		now.getTime() - packageAppCpuSampleRetentionDays * 24 * 60 * 60 * 1000,
	).toISOString()
}

/** Inserts one sample and prunes past the age and row caps. */
export function insertPackageAppCpuSample(
	sql: SqlStorage,
	sample: PackageAppCpuSample,
	now: Date = new Date(),
) {
	sql.exec(
		`INSERT OR IGNORE INTO package_app_cpu_samples
 (request_id, occurred_at, package_id, sample_json) VALUES (?, ?, ?, ?)`,
		sample.requestId,
		sample.occurredAt,
		sample.packageId,
		JSON.stringify(sample),
	)
	sql.exec(
		'DELETE FROM package_app_cpu_samples WHERE occurred_at < ?',
		retentionCutoff(now),
	)
	sql.exec(
		`DELETE FROM package_app_cpu_samples WHERE request_id IN (
  SELECT request_id FROM package_app_cpu_samples
  ORDER BY occurred_at DESC, request_id DESC LIMIT -1 OFFSET ?)`,
		packageAppCpuSampleMaxRows,
	)
}

export function summarizePackageAppCpuSampleRows(
	sql: SqlStorage,
	now: Date = new Date(),
): PackageAppCpuSummary {
	const since = retentionCutoff(now)
	const samples = sql
		.exec<{ sample_json: string }>(
			'SELECT sample_json FROM package_app_cpu_samples WHERE occurred_at >= ?',
			since,
		)
		.toArray()
		.map((row) => JSON.parse(row.sample_json) as PackageAppCpuSample)
	return summarizePackageAppCpuSamples({ since, samples })
}
