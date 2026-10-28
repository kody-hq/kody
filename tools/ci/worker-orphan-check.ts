/**
 * Read-only check for an uploaded-but-undeployed Worker version.
 *
 * Compares the newest Worker version (`wrangler versions list --json`) with
 * the active deployment (`wrangler deployments status --json`). When the
 * newest version is not part of the active deployment, classic
 * `wrangler secret bulk` fails with Cloudflare 10215, so the Deploy workflow
 * runs this before secret sync and again on failure. A mismatch is written to
 * the job summary and raised as an error annotation. The check never changes
 * Cloudflare state and never fails the job on its own.
 *
 * Usage:
 *   node tools/ci/worker-orphan-check.ts --phase preflight \
 *     --name kody-production --config <wrangler config> [--env production]
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { isExecutedDirectly, resolveLocalBinary } from '../node-runtime.ts'

type VersionRecord = {
	id: string
	createdOn: string
	tag: string
	message: string
	source: string
}

export type OrphanCheckResult =
	| {
			status: 'ok'
			newest: VersionRecord | null
			activeVersionIds: Array<string>
	  }
	| {
			status: 'orphan'
			undeployed: Array<VersionRecord>
			activeVersionIds: Array<string>
	  }

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null
		? (value as Record<string, unknown>)
		: null
}

function stringField(value: unknown) {
	return typeof value === 'string' ? value : ''
}

/**
 * Only id, time, tag, message, and source are kept. Author fields are dropped
 * on purpose: job summaries are public on this repository.
 */
export function normalizeVersions(versions: unknown): Array<VersionRecord> {
	if (!Array.isArray(versions)) return []
	const records: Array<VersionRecord> = []
	for (const raw of versions) {
		const version = asRecord(raw)
		if (!version || typeof version.id !== 'string') continue
		const metadata = asRecord(version.metadata) ?? {}
		const annotations = asRecord(version.annotations) ?? {}
		records.push({
			id: version.id,
			createdOn: stringField(metadata.created_on),
			tag: stringField(annotations['workers/tag']),
			message: stringField(annotations['workers/message']),
			source:
				stringField(annotations['workers/triggered_by']) ||
				stringField(metadata.source),
		})
	}
	return records.sort((left, right) =>
		right.createdOn.localeCompare(left.createdOn),
	)
}

export function activeDeploymentVersionIds(deployment: unknown) {
	const versions = asRecord(deployment)?.versions
	if (!Array.isArray(versions)) return []
	return versions
		.map((entry) => asRecord(entry)?.version_id)
		.filter((id): id is string => typeof id === 'string')
}

export function checkForOrphanVersion(
	versions: unknown,
	deployment: unknown,
): OrphanCheckResult {
	const records = normalizeVersions(versions)
	const activeVersionIds = activeDeploymentVersionIds(deployment)
	const newest = records[0] ?? null
	if (!newest || activeVersionIds.includes(newest.id)) {
		return { status: 'ok', newest, activeVersionIds }
	}
	const undeployed: Array<VersionRecord> = []
	for (const record of records) {
		if (activeVersionIds.includes(record.id)) break
		undeployed.push(record)
	}
	return { status: 'orphan', undeployed, activeVersionIds }
}

function escapeAnnotation(text: string) {
	return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

function escapeCell(text: string) {
	return (text || '-').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

export function formatOrphanReport(input: {
	workerName: string
	phase: string
	result: Extract<OrphanCheckResult, { status: 'orphan' }>
}) {
	const { workerName, phase, result } = input
	const newest = result.undeployed[0]
	const annotation = `::error title=Undeployed Worker version (${workerName})::${escapeAnnotation(
		`${phase}: newest ${workerName} version ${newest?.id ?? 'unknown'} (created ${newest?.createdOn || 'unknown'}, tag ${newest?.tag || 'none'}) is not in the active deployment (${result.activeVersionIds.join(', ') || 'none'}). Classic secret bulk will fail with 10215 until a deploy promotes a newer version.`,
	)}`
	const rows = result.undeployed
		.map(
			(record) =>
				`| \`${record.id}\` | ${escapeCell(record.createdOn)} | ${escapeCell(record.tag)} | ${escapeCell(record.message)} | ${escapeCell(record.source)} |`,
		)
		.join('\n')
	const summary = [
		`### Undeployed Worker version on \`${workerName}\` (${phase})`,
		'',
		'The newest uploaded version is not part of the active deployment.',
		'Tags of the form `gh-<run_id>-<attempt>` name the Deploy run that uploaded it.',
		'',
		'| Version | Created (UTC) | Tag | Message | Source |',
		'| --- | --- | --- | --- | --- |',
		rows,
		'',
		`Active deployment versions: ${result.activeVersionIds.map((id) => `\`${id}\``).join(', ') || 'none'}`,
		'',
	].join('\n')
	return { annotation, summary }
}

function parseJsonStdout(stdout: string): unknown {
	const start = stdout.search(/[[{]/)
	if (start === -1) return null
	try {
		return JSON.parse(stdout.slice(start))
	} catch {
		return null
	}
}

function readWrangler(args: Array<string>) {
	const result = spawnSync(resolveLocalBinary('wrangler'), args, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		maxBuffer: 16 * 1024 * 1024,
		env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
	})
	if (result.status !== 0) return { ok: false as const }
	return { ok: true as const, json: parseJsonStdout(result.stdout ?? '') }
}

function parseArgs(argv: Array<string>) {
	const options = { phase: 'check', name: '', config: '', env: '' }
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		const value = argv[index + 1] ?? ''
		if (arg === '--phase') options.phase = value
		else if (arg === '--name') options.name = value
		else if (arg === '--config') options.config = value
		else if (arg === '--env') options.env = value
		else continue
		index += 1
	}
	return options
}

export function main(argv = process.argv.slice(2)) {
	const options = parseArgs(argv)
	if (!options.name) {
		console.log('::warning::worker-orphan-check: missing --name; skipping.')
		return
	}
	if (options.config && !existsSync(options.config)) {
		console.log(
			`worker-orphan-check: ${options.config} not generated yet; skipping ${options.name}.`,
		)
		return
	}
	const targetArgs = ['--name', options.name]
	if (options.config) targetArgs.push('--config', options.config)
	if (options.env) targetArgs.push('--env', options.env)

	const versions = readWrangler(['versions', 'list', '--json', ...targetArgs])
	const deployment = readWrangler([
		'deployments',
		'status',
		'--json',
		...targetArgs,
	])
	if (!versions.ok || !deployment.ok) {
		console.log(
			`::warning::worker-orphan-check could not read versions or deployments for ${options.name}; skipping.`,
		)
		return
	}
	const result = checkForOrphanVersion(versions.json, deployment.json)
	if (result.status === 'ok') {
		console.log(
			`worker-orphan-check (${options.phase}): ${options.name} newest version ${result.newest?.id ?? 'none'} is deployed.`,
		)
		return
	}
	const report = formatOrphanReport({
		workerName: options.name,
		phase: options.phase,
		result,
	})
	console.log(report.annotation)
	const summaryPath = process.env.GITHUB_STEP_SUMMARY
	if (summaryPath) appendFileSync(summaryPath, `${report.summary}\n`)
	else console.log(report.summary)
}

if (isExecutedDirectly(import.meta.url)) {
	try {
		main()
	} catch (error) {
		console.log(
			`::warning::worker-orphan-check failed: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}
