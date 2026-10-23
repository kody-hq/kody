/**
 * Copy Wrangler debug logs into an artifact directory, but only files that
 * provably contain no secret values.
 *
 * Wrangler writes every log level (including debug) to
 * `~/.config/.wrangler/logs`. It drops the Authorization header and omits
 * request bodies unless `WRANGLER_LOG_SANITIZE=false`, but this script still
 * verifies each file against every secret value the job can see
 * (`WRANGLER_LOG_SCAN_SECRETS`, the JSON of the workflow `secrets` context)
 * and against bearer-token shapes. Any match drops that file. Missing or
 * unparsable secret input copies nothing (fail closed). Values are never
 * printed; only file names and counts are.
 *
 * Usage:
 *   node tools/ci/collect-wrangler-logs.ts --from <dir> --out <dir>
 */
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
} from 'node:fs'
import path from 'node:path'
import { isExecutedDirectly } from '../node-runtime.ts'

export const secretsEnvName = 'WRANGLER_LOG_SCAN_SECRETS'

/**
 * Every secret of 4+ characters is scanned. A shorter value cannot be a
 * credential, and matching it would drop every log file.
 */
const minimumSecretLength = 4

const credentialShapePatterns = [
	/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/"?authorization"?\s*[:=]\s*"?[A-Za-z0-9._~+/-]{20,}/i,
]

export function parseSecretValues(raw: string | undefined) {
	if (!raw) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return null
	}
	if (typeof parsed !== 'object' || parsed === null) return null
	const needles = new Set<string>()
	for (const value of Object.values(parsed as Record<string, unknown>)) {
		if (typeof value !== 'string') continue
		const candidates = [value, value.trim(), JSON.stringify(value).slice(1, -1)]
		// Multi-line values (PEM keys) can be logged one line at a time.
		for (const line of value.split(/\r?\n/)) candidates.push(line.trim())
		for (const candidate of candidates) {
			if (candidate.length >= minimumSecretLength) needles.add(candidate)
		}
	}
	return needles
}

export function logLeaksSecret(text: string, needles: ReadonlySet<string>) {
	for (const needle of needles) {
		if (text.includes(needle)) return true
	}
	return credentialShapePatterns.some((pattern) => pattern.test(text))
}

export function collectWranglerLogs(input: {
	from: string
	out: string
	secretsJson: string | undefined
}) {
	const needles = parseSecretValues(input.secretsJson)
	if (!needles) {
		return {
			copied: [] as Array<string>,
			dropped: [] as Array<string>,
			reason: `${secretsEnvName} missing or invalid; copied nothing`,
		}
	}
	if (!existsSync(input.from)) {
		return { copied: [], dropped: [], reason: 'no wrangler log directory' }
	}
	const copied: Array<string> = []
	const dropped: Array<string> = []
	for (const name of readdirSync(input.from).sort()) {
		const source = path.join(input.from, name)
		if (!statSync(source).isFile()) continue
		const text = readFileSync(source, 'utf8')
		if (logLeaksSecret(text, needles)) {
			dropped.push(name)
			continue
		}
		mkdirSync(input.out, { recursive: true })
		copyFileSync(source, path.join(input.out, name))
		copied.push(name)
	}
	return { copied, dropped, reason: '' }
}

function readFlag(argv: Array<string>, flag: string) {
	const index = argv.indexOf(flag)
	return index === -1 ? '' : (argv[index + 1] ?? '')
}

export function main(argv = process.argv.slice(2)) {
	const from = readFlag(argv, '--from')
	const out = readFlag(argv, '--out')
	if (!from || !out) {
		console.error('Usage: collect-wrangler-logs.ts --from <dir> --out <dir>')
		process.exitCode = 1
		return
	}
	const result = collectWranglerLogs({
		from,
		out,
		secretsJson: process.env[secretsEnvName],
	})
	if (result.reason) console.log(`collect-wrangler-logs: ${result.reason}.`)
	console.log(
		`collect-wrangler-logs: copied ${String(result.copied.length)} file(s), dropped ${String(result.dropped.length)} file(s) that matched a secret value or credential shape.`,
	)
	for (const name of result.dropped) {
		console.log(
			`::warning::Dropped wrangler log ${name} from the artifact: it matched a secret value or credential shape.`,
		)
	}
	const outputPath = process.env.GITHUB_OUTPUT
	if (outputPath) {
		appendFileSync(
			outputPath,
			`has_logs=${result.copied.length > 0 ? 'true' : 'false'}\n`,
		)
	}
}

if (isExecutedDirectly(import.meta.url)) {
	main()
}
