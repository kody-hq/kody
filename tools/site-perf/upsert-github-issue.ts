import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { isExecutedDirectly } from '../node-runtime.ts'
import type { SitePerfReport } from './collect.ts'

export const okTitle = 'Weekly site perf: all clear'
export const needsFixTitle = 'Weekly site perf: needs a fix'

/** Older titles this workflow used to open. Close them on a later `ok`. */
export const staleNeedsFixTitles = [
	needsFixTitle,
	'Weekly site perf: actionable',
	'Weekly site perf: human review',
]

function gh(args: Array<string>) {
	const result = spawnSync('gh', args, { encoding: 'utf8' })
	if (result.status !== 0) {
		throw new Error(result.stderr || `gh ${args.join(' ')} failed`)
	}
	return result.stdout
}

function issueBody(report: SitePerfReport) {
	const findings =
		report.findings.length === 0
			? '- none'
			: report.findings
					.map((finding) => `- \`${finding.id}\`: ${finding.message}`)
					.join('\n')
	return [
		`Verdict: **${report.verdict}**`,
		`URL: ${report.url}`,
		`Fetched: ${report.fetchedAt}`,
		`HTML: ${report.htmlBytes} bytes`,
		`Largest same-origin JS: ${report.largestSameOriginJsBytes ?? 'n/a'} bytes`,
		`LCP image: ${report.lcpImageBytes ?? 'n/a'} bytes`,
		`TTFB: ${report.ttfbMs ?? 'n/a'} ms`,
		`Server-Timing: ${
			report.serverTiming.length === 0
				? 'n/a'
				: report.serverTiming
						.map((entry) =>
							entry.desc
								? `${entry.name}=${entry.durationMs}ms (${entry.desc})`
								: `${entry.name}=${entry.durationMs}ms`,
						)
						.join(', ')
		}`,
		`Cache-Control: ${report.cacheControl ?? 'n/a'}`,
		'',
		'Findings:',
		findings,
		'',
		'```json',
		JSON.stringify(report, null, 2),
		'```',
	].join('\n')
}

function findOpenIssue(title: string) {
	const raw = gh([
		'issue',
		'list',
		'--search',
		`in:title "${title}"`,
		'--state',
		'open',
		'--json',
		'number,title',
	])
	const issues = JSON.parse(raw) as Array<{ number: number; title: string }>
	return issues.find((issue) => issue.title === title) ?? null
}

export function upsertSitePerfIssue(report: SitePerfReport) {
	const body = issueBody(report)
	if (report.verdict === 'ok') {
		for (const staleTitle of staleNeedsFixTitles) {
			const stale = findOpenIssue(staleTitle)
			if (!stale) continue
			gh([
				'issue',
				'comment',
				String(stale.number),
				'--body',
				`Latest weekly measure is **ok**. Closing.\n\n${body}`,
			])
			gh(['issue', 'close', String(stale.number), '--reason', 'completed'])
		}
		return { action: 'cleared' as const }
	}
	const existing = findOpenIssue(needsFixTitle)
	if (existing) {
		gh(['issue', 'comment', String(existing.number), '--body', body])
		return { action: 'commented' as const, number: existing.number }
	}
	const created = gh([
		'issue',
		'create',
		'--title',
		needsFixTitle,
		'--body',
		body,
	])
	return { action: 'created' as const, url: created.trim() }
}

if (isExecutedDirectly(import.meta.url)) {
	const reportPath = process.argv[2] ?? 'site-perf-report.json'
	const report = JSON.parse(
		await readFile(reportPath, 'utf8'),
	) as SitePerfReport
	const result = upsertSitePerfIssue(report)
	process.stdout.write(`${JSON.stringify(result)}\n`)
}
