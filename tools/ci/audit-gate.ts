import { spawnSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { isExecutedDirectly } from '../node-runtime.ts'

/**
 * Production dependency audit (`npm run audit:prod`).
 *
 * Runs `npm audit --omit=dev --json` and decides whether moderate, high, or
 * critical findings fail:
 * - `enforce`: findings fail (exit 1). Used when the change touches a
 *   dependency manifest (any `package.json`, `package-lock.json`, or
 *   `npm-shrinkwrap.json`), so a dependency PR cannot add or keep a known
 *   advisory.
 * - `report`: findings print as GitHub `::warning` annotations and exit 0.
 *   Used on `main` pushes and on changes that leave dependencies alone, so a
 *   newly published advisory does not fail unrelated work. The scheduled
 *   `🔐 Audit bump` workflow opens the fix PR instead.
 *
 * `AUDIT_MODE=enforce|report` (or `--mode=`) forces a mode. Otherwise
 * (`auto`) the changed paths come from `git diff --name-only <merge-base>`
 * against `AUDIT_BASE` (CI passes the PR base SHA) or `origin/main`, working
 * tree included. When that diff cannot be listed the gate enforces.
 */

type AuditSeverity = 'info' | 'low' | 'moderate' | 'high' | 'critical'
type AuditMode = 'enforce' | 'report'

type AuditFinding = {
	name: string
	severity: AuditSeverity
	advisories: Array<{ title: string; url: string }>
	fixAvailable: boolean
}

const severityRank: Record<AuditSeverity, number> = {
	info: 0,
	low: 1,
	moderate: 2,
	high: 3,
	critical: 4,
}

const dependencyManifestNames = new Set([
	'package.json',
	'package-lock.json',
	'npm-shrinkwrap.json',
])

export function isDependencyManifestPath(filePath: string) {
	const name = filePath.trim().split('/').at(-1) ?? ''
	return dependencyManifestNames.has(name)
}

export function resolveAuditMode({
	requested,
	changedPaths,
}: {
	requested: string | undefined
	changedPaths: Array<string> | null
}): AuditMode {
	if (requested === 'enforce' || requested === 'report') return requested
	if (changedPaths === null) return 'enforce'
	return changedPaths.some(isDependencyManifestPath) ? 'enforce' : 'report'
}

function isSeverity(value: unknown): value is AuditSeverity {
	return typeof value === 'string' && value in severityRank
}

/** Moderate-or-worse findings from an `npm audit --json` (v2) report. */
export function parseAuditFindings(report: unknown): Array<AuditFinding> {
	if (!report || typeof report !== 'object') {
		throw new Error('npm audit returned no JSON report')
	}
	const record = report as Record<string, unknown>
	if (record.error) {
		throw new Error(`npm audit failed: ${JSON.stringify(record.error)}`)
	}
	const vulnerabilities = record.vulnerabilities
	if (!vulnerabilities || typeof vulnerabilities !== 'object') {
		throw new Error('npm audit report has no vulnerabilities map')
	}
	const findings: Array<AuditFinding> = []
	for (const [name, raw] of Object.entries(vulnerabilities)) {
		const entry = raw as {
			severity?: unknown
			via?: Array<unknown>
			fixAvailable?: unknown
		}
		if (!isSeverity(entry.severity)) continue
		if (severityRank[entry.severity] < severityRank.moderate) continue
		const advisories: AuditFinding['advisories'] = []
		const viaPackages: Array<string> = []
		for (const via of entry.via ?? []) {
			if (typeof via === 'string') {
				viaPackages.push(via)
				continue
			}
			const advisory = via as { title?: unknown; url?: unknown }
			if (typeof advisory.title === 'string') {
				advisories.push({
					title: advisory.title,
					url: typeof advisory.url === 'string' ? advisory.url : '',
				})
			}
		}
		if (advisories.length === 0 && viaPackages.length > 0) {
			advisories.push({
				title: `depends on vulnerable ${viaPackages.join(', ')}`,
				url: '',
			})
		}
		findings.push({
			name,
			severity: entry.severity,
			advisories,
			fixAvailable: entry.fixAvailable !== false,
		})
	}
	return findings.sort(
		(a, b) =>
			severityRank[b.severity] - severityRank[a.severity] ||
			a.name.localeCompare(b.name),
	)
}

function describeFinding(finding: AuditFinding) {
	const advisories = finding.advisories
		.map((advisory) =>
			advisory.url ? `${advisory.title} (${advisory.url})` : advisory.title,
		)
		.join('; ')
	return `${finding.name} [${finding.severity}]: ${advisories}`
}

function escapeAnnotation(value: string) {
	return value
		.replaceAll('%', '%25')
		.replaceAll('\r', '%0D')
		.replaceAll('\n', '%0A')
}

export function formatAuditMarkdown(findings: Array<AuditFinding>) {
	if (findings.length === 0) {
		return 'No moderate, high, or critical production advisories.\n'
	}
	const lines = findings.map((finding) => {
		const advisories = finding.advisories
			.map((advisory) =>
				advisory.url ? `[${advisory.title}](${advisory.url})` : advisory.title,
			)
			.join('; ')
		const fix = finding.fixAvailable ? '' : ' (no automatic fix)'
		return `- \`${finding.name}\` (${finding.severity})${fix}: ${advisories}`
	})
	return `${lines.join('\n')}\n`
}

function changedPathsSince(base: string): Array<string> | null {
	const mergeBase = spawnSync('git', ['merge-base', base, 'HEAD'], {
		encoding: 'utf8',
	})
	if (mergeBase.status !== 0) return null
	const diff = spawnSync(
		'git',
		['diff', '--name-only', mergeBase.stdout.trim()],
		{ encoding: 'utf8' },
	)
	if (diff.status !== 0) return null
	return diff.stdout
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
}

function readFlag(argv: Array<string>, name: string) {
	const prefix = `--${name}=`
	return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

function main(argv: Array<string> = process.argv.slice(2)) {
	const requested = readFlag(argv, 'mode') ?? process.env.AUDIT_MODE
	const base = process.env.AUDIT_BASE?.trim() || 'origin/main'
	const mode = resolveAuditMode({
		requested,
		changedPaths:
			requested === 'enforce' || requested === 'report'
				? []
				: changedPathsSince(base),
	})
	const markdownPath = readFlag(argv, 'markdown')

	const audit = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
	})
	let findings: Array<AuditFinding>
	try {
		findings = parseAuditFindings(JSON.parse(audit.stdout || 'null'))
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (mode === 'enforce') {
			console.error(`audit:prod (${mode}): ${message}`)
			if (audit.stderr) console.error(audit.stderr)
			return 1
		}
		console.log(`::warning title=npm audit::${escapeAnnotation(message)}`)
		return 0
	}

	if (markdownPath) writeFileSync(markdownPath, formatAuditMarkdown(findings))
	if (process.env.GITHUB_OUTPUT) {
		appendFileSync(process.env.GITHUB_OUTPUT, `findings=${findings.length}\n`)
	}

	if (findings.length === 0) {
		console.log(
			`audit:prod (${mode}): no moderate, high, or critical production advisories.`,
		)
		return 0
	}

	for (const finding of findings) {
		if (mode === 'report') {
			console.log(
				`::warning title=npm audit (${finding.severity})::${escapeAnnotation(describeFinding(finding))}`,
			)
		} else {
			console.error(describeFinding(finding))
		}
	}
	if (mode === 'report') {
		console.log(
			`audit:prod (report): ${findings.length} production advisory finding(s), reported only. Report mode (a main push, a forced AUDIT_MODE, or no dependency manifest change); the scheduled Audit bump workflow opens the fix PR.`,
		)
		return 0
	}
	console.error(
		`audit:prod (enforce): ${findings.length} moderate-or-worse production advisory finding(s). This change touches dependency manifests, so it must not ship known advisories. Fix with \`npm audit fix\` or a documented override (docs/contributing/dependency-overrides.md).`,
	)
	return 1
}

if (isExecutedDirectly(import.meta.url)) {
	process.exitCode = main()
}
