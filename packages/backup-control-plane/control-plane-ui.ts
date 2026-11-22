import { escapeHtml } from '@kody-internal/shared/escape-html.ts'
import {
	backupEscrowSecretStoreKeyKey,
	parseLegacyStagingSummary,
	parseStagingSummary,
	sealedFullManifestKey,
	stagingPrefix,
	stagingSummaryKey,
} from '@kody-internal/shared/backup-staging.ts'

import {
	configuredSourceDatabases,
	isBackupEnabled,
	pacedSourceDatabases,
	utcDay,
} from './backup-policy.ts'
import type { BackupEnvironment } from './backup-types.ts'
import {
	dayColumnLegend,
	deriveDayCells,
	parseStagingProgressFacts,
	stagingCatchUpLookbackDays,
	type DayCell,
	type DayCells,
	type SealFacts,
	type StagingProgressFacts,
	type StagingSummaryFacts,
} from './day-status.ts'
import { getD1Database } from './d1-import-api.ts'
import { verifyBackupFullManifestSignature } from './full-manifest-signing.ts'
import type { PacedDrillProgress } from './paced-restore-drill.ts'
import type { ProductionRestoreProgress } from './production-restore.ts'
import type { RestoreConfirmToken } from './restore-confirm-token.ts'
import { readFullManifest, readSealedPacedNight } from './seal-full-backup.ts'
import type { SealStatusView } from './seal-day-run.ts'

const DASHBOARD_DAY_COUNT = 14

function layout(
	title: string,
	body: string,
	options?: { danger?: boolean },
): string {
	const accent = options?.danger ? '#f07178' : '#7aa2f7'
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>
:root {
	color-scheme: light dark;
	--color-primary: oklch(0.54 0.18 145);
	--color-primary-hover: oklch(0.48 0.17 145);
	--color-on-primary: oklch(1 0 0);
	--color-primary-text: oklch(0.455 0.17 145);
	--color-background: oklch(0.93 0.004 250);
	--color-surface: oklch(0.975 0.002 250);
	--color-text: oklch(0.22 0.012 260);
	--color-text-muted: oklch(0.44 0.014 260);
	--color-border: oklch(0.84 0.008 250);
	--color-field-border: oklch(0.6 0.012 250);
	--color-danger: oklch(0.535 0.19 25);
	--color-danger-hover: oklch(0.5 0.18 25);
	--color-on-danger: oklch(0.985 0.005 25);
	--color-warning: oklch(0.72 0.16 85);
	--color-warning-text: oklch(0.48 0.15 80);
	--color-primary-dark: oklch(0.72 0.205 145);
	--color-primary-hover-dark: oklch(0.78 0.21 145);
	--color-on-primary-dark: oklch(0.2 0.05 148);
	--color-primary-text-dark: oklch(0.75 0.2 145);
	--color-background-dark: oklch(0.19 0.008 255);
	--color-surface-dark: oklch(0.235 0.01 255);
	--color-text-dark: oklch(0.945 0.005 250);
	--color-text-muted-dark: oklch(0.72 0.01 255);
	--color-border-dark: oklch(0.33 0.01 255);
	--color-field-border-dark: oklch(0.55 0.012 255);
	--color-danger-dark: oklch(0.75 0.16 25);
	--color-danger-hover-dark: oklch(0.7 0.17 25);
	--color-on-danger-dark: oklch(0.2 0.05 25);
	--color-warning-dark: oklch(0.84 0.16 85);
	--color-warning-text-dark: oklch(0.84 0.15 85);
	--font-display: 'Bricolage Grotesque', system-ui, sans-serif;
	--font-body: 'Wix Madefor Text', system-ui, sans-serif;
	--font-mono: ui-monospace, 'SF Mono', Menlo, monospace;
	--radius-card: 14px;
	--danger-bg: color-mix(in srgb, var(--color-danger) 12%, var(--color-surface));
	--accent: ${accent};
}
@media (prefers-color-scheme: dark) {
	:root {
		color-scheme: dark;
		--color-primary: var(--color-primary-dark);
		--color-primary-hover: var(--color-primary-hover-dark);
		--color-on-primary: var(--color-on-primary-dark);
		--color-primary-text: var(--color-primary-text-dark);
		--color-background: var(--color-background-dark);
		--color-surface: var(--color-surface-dark);
		--color-text: var(--color-text-dark);
		--color-text-muted: var(--color-text-muted-dark);
		--color-border: var(--color-border-dark);
		--color-field-border: var(--color-field-border-dark);
		--color-danger: var(--color-danger-dark);
		--color-danger-hover: var(--color-danger-hover-dark);
		--color-on-danger: var(--color-on-danger-dark);
		--color-warning: var(--color-warning-dark);
		--color-warning-text: var(--color-warning-text-dark);
	}
}
* { box-sizing: border-box; }
body {
	margin: 0;
	font: 15px/1.62 var(--font-body);
	color: var(--color-text);
	background: var(--color-background);
	min-height: 100vh;
}
main { max-width: 1120px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
header { margin-bottom: 1.75rem; }
h1 {
	font-family: var(--font-display);
	font-size: 1.7rem;
	font-weight: 650;
	margin: 0 0 0.35rem;
	letter-spacing: -0.02em;
}
h2 {
	font-family: var(--font-display);
	font-size: 1.15rem;
	font-weight: 600;
	margin: 0 0 0.75rem;
}
p, li { color: var(--color-text-muted); }
.lede { margin-top: 0; }
.panel {
	background: var(--color-surface);
	border: 1px solid var(--color-border);
	border-radius: var(--radius-card);
	padding: 1rem 1.1rem;
	margin-bottom: 1rem;
}
.panel.danger {
	background: var(--danger-bg);
	border-color: color-mix(in srgb, var(--color-danger) 45%, var(--color-border));
}
.grid { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.kv { display: flex; flex-direction: column; gap: 0.15rem; }
.kv span { color: var(--color-text-muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; }
.kv strong { font-weight: 600; color: var(--color-text); word-break: break-all; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
th, td { text-align: left; padding: 0.5rem 0.45rem; border-bottom: 1px solid var(--color-border); vertical-align: top; }
th { color: var(--color-text-muted); font-weight: 600; font-size: 0.75rem; letter-spacing: 0.03em; }
td { white-space: nowrap; }
td.wrap { white-space: normal; }
@media (max-width: 640px) {
	table.cards thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
	table.cards tr { display: block; padding: 0.6rem 0; border-bottom: 1px solid var(--color-border); }
	table.cards td { display: flex; justify-content: space-between; gap: 0.75rem; padding: 0.2rem 0; border-bottom: 0; white-space: normal; text-align: right; }
	table.cards td::before { content: attr(data-label); color: var(--color-text-muted); font-size: 0.75rem; text-align: left; flex: none; }
	table.cards td code { word-break: break-all; }
}
.neutral { color: var(--color-text-muted); }
.ok { color: var(--color-primary-text); font-weight: 600; }
.warn { color: var(--color-warning-text); font-weight: 600; }
.bad { color: var(--color-danger); font-weight: 600; }
.actions { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: end; }
label { display: flex; flex-direction: column; gap: 0.25rem; color: var(--color-text-muted); font-size: 0.85rem; }
input[type="text"], input[type="date"], select {
	background: var(--color-background);
	border: 1px solid var(--color-field-border);
	border-radius: 6px;
	color: var(--color-text);
	padding: 0.45rem 0.55rem;
	min-width: 12rem;
	font: inherit;
}
button, .button {
	appearance: none;
	border: 1px solid transparent;
	background: var(--color-primary);
	color: var(--color-on-primary);
	border-radius: 0.625rem;
	padding: 0.5rem 0.95rem;
	font: inherit;
	font-weight: 600;
	cursor: pointer;
	text-decoration: none;
	display: inline-block;
}
@supports (corner-shape: squircle) {
	button, .button { border-radius: 1.125rem; corner-shape: squircle; }
}
button:hover, .button:hover { background: var(--color-primary-hover); }
button.danger, .button.danger {
	background: var(--color-danger);
	color: var(--color-on-danger);
}
button.danger:hover, .button.danger:hover { background: var(--color-danger-hover); }
pre, code {
	font-family: var(--font-mono);
}
pre {
	white-space: pre-wrap;
	word-break: break-word;
	background: var(--color-background);
	border-radius: 6px;
	padding: 0.75rem;
	border: 1px solid var(--color-border);
	color: var(--color-text);
}
.flash { margin-bottom: 1rem; }
details.disclosure { margin-top: 0.85rem; }
details.disclosure summary {
	cursor: pointer;
	color: var(--color-text-muted);
	font-size: 0.875rem;
}
.legend { margin: 0.75rem 0 0; }
.legend dt { font-weight: 600; color: var(--color-text); }
.legend dd { margin: 0.15rem 0 0.7rem; color: var(--color-text-muted); }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`
}

function renderCell(cell: DayCell): string {
	const title = cell.detail ? ` title="${escapeHtml(cell.detail)}"` : ''
	return `<td class="${cell.tone}"${title}>${escapeHtml(cell.label)}</td>`
}

function disclosure(summary: string, body: string, open = false): string {
	const openAttr = open ? ' open' : ''
	return `<details class="disclosure"${openAttr}><summary>${escapeHtml(summary)}</summary>${body}</details>`
}

function shortCommit(commit: string): string {
	return /^[0-9a-f]{7,}$/i.test(commit) ? commit.slice(0, 7) : commit
}

function stagingProgressKey(day: string): string {
	return `${stagingPrefix(day)}exporter/progress.json`
}

function utcDayOffsetDate(day: string, daysBack: number): string {
	const date = new Date(`${day}T00:00:00.000Z`)
	date.setUTCDate(date.getUTCDate() - daysBack)
	return utcDay(date)
}

async function readBucketJson(
	bucket: R2Bucket,
	key: string,
): Promise<unknown | null | 'unreadable'> {
	try {
		const object = await bucket.get(key)
		if (object === null) return null
		return await object.json()
	} catch {
		return 'unreadable'
	}
}

function summaryFacts(value: unknown): StagingSummaryFacts | 'unreadable' {
	try {
		return {
			completedAtMs: Date.parse(parseStagingSummary(value).completedAt),
		}
	} catch {
		try {
			return {
				completedAtMs: Date.parse(parseLegacyStagingSummary(value).completedAt),
			}
		} catch {
			return 'unreadable'
		}
	}
}

export type DayStatus = {
	day: string
	d1Present: boolean
	d1Verified: boolean | null
	d1Restorable: boolean | null
	stagingPresent: boolean
	sealedPresent: boolean
	sealedVerified: boolean | null
	warnings: Array<string>
	cells: DayCells
}

type CollectedDay = DayStatus & {
	stagingSummary: StagingSummaryFacts | null | 'unreadable'
	stagingProgress: StagingProgressFacts | null | 'unreadable'
	seal: SealFacts
}

export async function collectDayStatuses(
	env: BackupEnvironment,
	now: Date = new Date(),
): Promise<Array<DayStatus>> {
	const days: Array<CollectedDay> = []
	for (let offset = 0; offset < DASHBOARD_DAY_COUNT; offset += 1) {
		const date = new Date(now)
		date.setUTCDate(date.getUTCDate() - offset)
		const day = utcDay(date)
		const warnings: Array<string> = []
		let d1Present = true
		const d1Verified: boolean | null = null
		const d1Restorable: boolean | null = null
		try {
			for (const source of pacedSourceDatabases(env)) {
				const paced = await readSealedPacedNight(env.BACKUP_BUCKET, source, day)
				if (paced.kind === 'incomplete') {
					d1Present = false
					warnings.push(`${source.name}: ${paced.reason}`)
				}
			}
		} catch {
			d1Present = false
			warnings.push('paced D1 seals unreadable')
		}

		const summaryJson = await readBucketJson(
			env.BACKUP_BUCKET,
			stagingSummaryKey(day),
		)
		let stagingSummary: StagingSummaryFacts | null | 'unreadable' = null
		if (summaryJson === 'unreadable') {
			stagingSummary = 'unreadable'
			warnings.push('staging summary unreadable')
		} else if (summaryJson !== null) {
			stagingSummary = summaryFacts(summaryJson)
			if (stagingSummary === 'unreadable') {
				warnings.push('staging summary unreadable')
			}
		}
		const stagingPresent =
			stagingSummary !== null && stagingSummary !== 'unreadable'

		const progressJson = await readBucketJson(
			env.BACKUP_BUCKET,
			stagingProgressKey(day),
		)
		let stagingProgress: StagingProgressFacts | null | 'unreadable' = null
		if (progressJson === 'unreadable') {
			stagingProgress = 'unreadable'
			warnings.push('staging progress unreadable')
		} else if (progressJson !== null) {
			stagingProgress = parseStagingProgressFacts(progressJson)
			if (stagingProgress === null) {
				stagingProgress = 'unreadable'
				warnings.push('staging progress unreadable')
			}
		}

		let sealedPresent = false
		let sealedVerified: boolean | null = null
		let seal: SealFacts = 'absent'
		try {
			const full = await readFullManifest(
				env.BACKUP_BUCKET,
				sealedFullManifestKey(day),
			)
			sealedPresent = full !== null
			if (full !== null) {
				sealedVerified = await verifyBackupFullManifestSignature(env, full)
				seal = sealedVerified ? 'verified' : 'invalid'
				if (!sealedVerified) warnings.push('full manifest signature invalid')
			}
		} catch {
			sealedVerified = null
			seal = 'unreadable'
			warnings.push('full manifest unreadable')
		}

		days.push({
			day,
			d1Present,
			d1Verified,
			d1Restorable,
			stagingPresent,
			sealedPresent,
			sealedVerified,
			warnings,
			stagingSummary,
			stagingProgress,
			seal,
			cells: {
				d1Manifest: { tone: 'neutral', label: '—' },
				d1Verified: { tone: 'neutral', label: '—' },
				d1Restorable: { tone: 'neutral', label: '—' },
				staging: { tone: 'neutral', label: '—' },
				sealed: { tone: 'neutral', label: '—' },
				sealVerified: { tone: 'neutral', label: '—' },
			},
		})
	}
	let activeStagingDay =
		[...days]
			.reverse()
			.find(
				(day) =>
					day.stagingProgress !== null &&
					day.stagingProgress !== 'unreadable' &&
					!day.stagingPresent &&
					day.stagingSummary !== 'unreadable',
			)?.day ?? null
	// Exporter lookback is today plus 14 days back. The table is 14 rows
	// (today through today-13), so today-14 can be the real queue head
	// without appearing here. Honor it or the next seed looks failed.
	const lookbackEdge = utcDayOffsetDate(utcDay(now), stagingCatchUpLookbackDays)
	const edgeSummary = await readBucketJson(
		env.BACKUP_BUCKET,
		stagingSummaryKey(lookbackEdge),
	)
	const edgeProgress = await readBucketJson(
		env.BACKUP_BUCKET,
		stagingProgressKey(lookbackEdge),
	)
	const edgeSummaryFacts =
		edgeSummary === 'unreadable' || edgeSummary === null
			? edgeSummary
			: summaryFacts(edgeSummary)
	const edgeProgressFacts =
		edgeProgress === 'unreadable' || edgeProgress === null
			? edgeProgress
			: (parseStagingProgressFacts(edgeProgress) ?? 'unreadable')
	if (
		edgeProgressFacts !== null &&
		edgeProgressFacts !== 'unreadable' &&
		edgeSummaryFacts === null
	) {
		activeStagingDay = lookbackEdge
	}
	for (const day of days) {
		day.cells = deriveDayCells({
			day: day.day,
			now,
			today: utcDay(now),
			d1Present: day.d1Present,
			d1Verified: day.d1Verified,
			d1Restorable: day.d1Restorable,
			stagingSummary: day.stagingSummary,
			stagingProgress: day.stagingProgress,
			activeStagingDay,
			seal: day.seal,
		})
	}
	return days
}

export async function renderDashboard(
	env: BackupEnvironment,
	options: { flashHtml?: string; now?: Date } = {},
): Promise<string> {
	const now = options.now ?? new Date()
	const enabled = isBackupEnabled(env)
	const sources = configuredSourceDatabases(env)
	const sourceSizeParts: Array<string> = []
	for (const source of sources) {
		try {
			const meta = await getD1Database({
				accountId: env.SOURCE_ACCOUNT_ID,
				databaseId: source.id,
				token: env.CLOUDFLARE_API_TOKEN,
			})
			sourceSizeParts.push(
				`<div class="kv"><span>${escapeHtml(source.name)} file size</span><strong>${escapeHtml(meta.fileSize.toLocaleString('en-US'))} bytes</strong></div>`,
			)
		} catch (error) {
			const message = error instanceof Error ? error.message : 'lookup failed'
			sourceSizeParts.push(
				`<div class="kv"><span>${escapeHtml(source.name)} file_size</span><span class="bad">${escapeHtml(message)}</span></div>`,
			)
		}
	}
	const escrowPresent =
		(await env.BACKUP_BUCKET.head(backupEscrowSecretStoreKeyKey)) !== null
	const days = await collectDayStatuses(env, now)
	const dayRows = days
		.map((day) => {
			return `<tr>
<td><code>${escapeHtml(day.day)}</code></td>
${renderCell(day.cells.d1Manifest)}
${renderCell(day.cells.d1Verified)}
${renderCell(day.cells.d1Restorable)}
${renderCell(day.cells.staging)}
${renderCell(day.cells.sealed)}
${renderCell(day.cells.sealVerified)}
<td class="wrap">${day.warnings.length === 0 ? '<span class="neutral">—</span>' : escapeHtml(day.warnings.join('; '))}</td>
</tr>`
		})
		.join('\n')
	const columnHeaders = dayColumnLegend
		.map(
			(column) =>
				`<th title="${escapeHtml(column.text)}">${escapeHtml(column.label)}</th>`,
		)
		.join('\n\t\t\t\t')
	const legend = dayColumnLegend
		.map(
			(column) =>
				`<dt>${escapeHtml(column.label)}</dt><dd>${escapeHtml(column.text)}</dd>`,
		)
		.join('\n')
	const databaseNames = sources.map((source) => source.name).join(', ')
	const identifierRows = [
		`<div class="kv"><span>Account</span><strong>${escapeHtml(env.SOURCE_ACCOUNT_ID)}</strong></div>`,
		...sources.map(
			(source) =>
				`<div class="kv"><span>${escapeHtml(source.name)} database</span><strong>${escapeHtml(source.id)}</strong></div>`,
		),
		`<div class="kv"><span>Build commit</span><strong>${escapeHtml(env.BUILD_COMMIT)}</strong></div>`,
	].join('\n')

	const body = `
<header>
	<h1>Kody DR backup control plane</h1>
	<p>Operator dashboard for full-day sealing, isolated drills, and graduated production restore.</p>
</header>
${options.flashHtml ?? ''}
<section class="panel">
	<h2>Enable gate</h2>
	<div class="grid">
		<div class="kv"><span>ENABLE_PRODUCTION_D1_BACKUPS</span><strong>${escapeHtml(env.ENABLE_PRODUCTION_D1_BACKUPS)}</strong></div>
		<div class="kv"><span>BACKUP_BENCHMARK_APPROVED</span><strong>${escapeHtml(env.BACKUP_BENCHMARK_APPROVED)}</strong></div>
		<div class="kv"><span>isBackupEnabled</span><strong class="${enabled ? 'ok' : 'bad'}">${enabled ? 'true' : 'false'}</strong></div>
	</div>
</section>
<section class="panel">
	<h2>Source identity</h2>
	<div class="grid">
		<div class="kv"><span>Databases</span><strong>${escapeHtml(databaseNames || 'none configured')}</strong></div>
		<div class="kv"><span>Build</span><strong>${escapeHtml(shortCommit(env.BUILD_COMMIT))}</strong></div>
		<div class="kv"><span>Escrow blob</span><strong class="${escrowPresent ? 'ok' : 'warn'}">${escrowPresent ? 'present' : 'missing'}</strong></div>
		${sourceSizeParts.join('\n\t\t')}
	</div>
	${disclosure('Identifiers', `<div class="grid">${identifierRows}</div>`)}
</section>
<section class="panel">
	<h2>Recent days</h2>
	<p class="lede">Gray is waiting or in progress. Amber is late and still moving. Red is a failure that needs action.</p>
	<div class="table-wrap">
	<table>
		<thead>
			<tr>
				<th>Day</th>
				${columnHeaders}
				<th>Warnings</th>
			</tr>
		</thead>
		<tbody>
			${dayRows}
		</tbody>
	</table>
	</div>
	${disclosure('What the columns mean', `<dl class="legend">${legend}</dl>`, true)}
</section>
<section class="panel">
	<h2>Actions</h2>
	<div class="actions">
		<form method="post" action="/actions/seal-day" class="actions">
			<label>Day
				<input type="text" name="day" placeholder="YYYY-MM-DD" required pattern="\\d{4}-\\d{2}-\\d{2}"/>
			</label>
			<button type="submit">Seal day</button>
		</form>
		<form method="post" action="/actions/run-paced-drill" class="actions" onsubmit="return confirm('Start an isolated paced restore drill for APP, AUDIT and JOBS?');">
			<button type="submit">Run isolated paced restore drill</button>
		</form>
	</div>
	<p>Seal day queues the work and returns immediately. The status page shows progress, success, or why the day is not ready.</p>
</section>
<section class="panel danger">
	<h2>Production restore (dangerous)</h2>
	<p>This path imports SQL into every configured production D1 (APP_DB then JOBS_DB) and then restores sealed durable stores through the primary worker. Use only during an approved incident.</p>
	<form method="post" action="/actions/restore/prepare" class="actions" onsubmit="return confirm('Prepare a PRODUCTION restore confirmation for this day?');">
		<label>Day
			<input type="text" name="day" placeholder="YYYY-MM-DD" required pattern="\\d{4}-\\d{2}-\\d{2}"/>
		</label>
		<button class="danger" type="submit">Prepare production restore</button>
	</form>
</section>`
	return layout('Kody DR backup control plane', body)
}

export function renderMessagePage(
	title: string,
	message: string,
	options?: { danger?: boolean; details?: string },
): string {
	const body = `
<header>
	<h1>${escapeHtml(title)}</h1>
</header>
<section class="panel${options?.danger ? ' danger' : ''}">
	<p>${escapeHtml(message)}</p>
	${options?.details ? disclosure('Technical details', `<pre>${escapeHtml(options.details)}</pre>`) : ''}
	<p><a class="button" href="/">Back to dashboard</a></p>
</section>`
	return layout(title, body, { danger: options?.danger })
}

export function renderSealStatusPage(input: {
	day: string
	instanceId: string
	view: SealStatusView
}): string {
	const refreshUrl = `/seal-status?id=${encodeURIComponent(input.instanceId)}`
	let title = 'Seal day'
	let message = ''
	let danger = false
	switch (input.view.kind) {
		case 'pending':
			message = `Seal for ${input.day} is ${input.view.status}. This page refreshes until the workflow finishes.`
			break
		case 'sealed':
			message = input.view.alreadySealed
				? `Day ${input.day} was already sealed at ${input.view.manifestKey}.`
				: `Sealed day ${input.day} at ${input.view.manifestKey}.`
			break
		case 'incomplete':
			title = 'Seal day incomplete'
			danger = true
			message = `Day ${input.day} is not ready to seal (${input.view.reason}).`
			break
		case 'failed':
			title = 'Seal day failed'
			danger = true
			message = input.view.message
			break
		default: {
			const exhaustive: never = input.view
			throw exhaustive
		}
	}
	const body = `
<header>
	<h1>${escapeHtml(title)}</h1>
</header>
<section class="panel${danger ? ' danger' : ''}">
	<p>${escapeHtml(message)}</p>
	${disclosure('Workflow id', `<p><code>${escapeHtml(input.instanceId)}</code></p>`)}
	<p>
		<a class="button" href="${escapeHtml(refreshUrl)}">Refresh</a>
		<a class="button" href="/">Back to dashboard</a>
	</p>
	${
		input.view.kind === 'pending'
			? `<meta http-equiv="refresh" content="5;url=${escapeHtml(refreshUrl)}"/>`
			: ''
	}
</section>`
	return layout(title, body, { danger })
}

function drillCell(value: boolean | null): string {
	if (value === null) return '<td data-label="Result">pending</td>'
	return value
		? '<td data-label="Result" style="color: var(--color-primary-text)">PASS</td>'
		: '<td data-label="Result" style="color: var(--color-danger)"><strong>FAIL</strong></td>'
}

export function renderPacedDrillStatusPage(
	progress: PacedDrillProgress,
): string {
	const running = progress.status === 'running'
	const verdict = running
		? 'RUNNING'
		: progress.status === 'passed'
			? 'PASS'
			: 'FAIL'
	const sources = progress.sources
		.map((source) => {
			const rows = source.tables
				.map(
					(table) => `<tr>
	<td data-label="Table">${escapeHtml(table.table)}</td>
	<td data-label="Manifest rows">${table.manifestCount}</td>
	<td data-label="Imported rows">${table.importedRows}</td>
	<td data-label="Target rows">${table.targetCount === null ? '?' : table.targetCount}</td>
	<td data-label="Manifest checksum"><code>${escapeHtml(table.manifestChecksum)}</code></td>
	<td data-label="Target checksum"><code>${escapeHtml(table.targetChecksum ?? '?')}</code></td>
	${drillCell(table.ok)}
</tr>`,
				)
				.join('')
			return `<section class="panel${source.phase === 'failed' ? ' danger' : ''}">
	<h2>${escapeHtml(source.databaseName)}: ${escapeHtml(source.phase)}</h2>
	<p>Units ${source.unitsDone} of ${source.unitsTotal}. Chain ${escapeHtml(source.chainDays.join(', ') || 'n/a')}. quick_check ${escapeHtml(source.quickCheck ?? 'n/a')}.${source.keptForInspection ? ` Target ${escapeHtml(source.targetDatabaseId ?? '')} kept for inspection.` : ''}</p>
	${source.error ? `<p><strong>${escapeHtml(source.error)}</strong></p>` : ''}
	<table class="cards">
		<thead><tr><th>Table</th><th>Manifest rows</th><th>Imported rows</th><th>Target rows</th><th>Manifest checksum</th><th>Target checksum</th><th>Result</th></tr></thead>
		<tbody>${rows}</tbody>
	</table>
</section>`
		})
		.join('')
	const body = `<section class="panel${progress.status === 'failed' ? ' danger' : ''}">
	<h1>Paced restore drill: ${verdict}</h1>
	<p>Run ${escapeHtml(progress.runId)} restores the sealed paced chain ending ${escapeHtml(progress.day)} into isolated drill databases. Updated ${escapeHtml(progress.updatedAt)}.</p>
	<p><a class="button" href="/">Dashboard</a></p>
	${running ? `<meta http-equiv="refresh" content="5"/>` : ''}
</section>
${sources}`
	return layout('Paced restore drill', body, {
		danger: progress.status === 'failed',
	})
}

export function renderRestorePreparePage(input: {
	day: string
	sourceDatabaseName: string
	pacedSourceNames: Array<string>
	token: RestoreConfirmToken
}): string {
	const d1Evidence = `<div class="kv"><span>D1 source</span><strong>Sealed paced chains: ${escapeHtml(input.pacedSourceNames.join(', '))}</strong></div>`
	const body = `
<header>
	<h1>Confirm PRODUCTION restore</h1>
	<p class="bad">This will overwrite production D1 contents and restore sealed stores for the selected day.</p>
</header>
<section class="panel danger">
	<h2>Restore target</h2>
	<div class="grid">
		<div class="kv"><span>Day</span><strong>${escapeHtml(input.day)}</strong></div>
		<div class="kv"><span>Database name</span><strong>${escapeHtml(input.sourceDatabaseName)}</strong></div>
		${d1Evidence}
		<div class="kv"><span>Token expires</span><strong>${escapeHtml(input.token.expiresAt)}</strong></div>
	</div>
	<form method="post" action="/actions/restore/execute" class="actions" style="margin-top:1rem" onsubmit="return confirm('Type-confirm and EXECUTE production restore now?');">
		<input type="hidden" name="day" value="${escapeHtml(input.day)}"/>
		<input type="hidden" name="expiresAt" value="${escapeHtml(input.token.expiresAt)}"/>
		<input type="hidden" name="confirmToken" value="${escapeHtml(input.token.token)}"/>
		<label>Type the production database name exactly (${escapeHtml(input.sourceDatabaseName)})
			<input type="text" name="typedDatabaseName" required autocomplete="off"/>
		</label>
		<button class="danger" type="submit">Execute production restore</button>
	</form>
	<p><a class="button" href="/">Cancel</a></p>
</section>`
	return layout('Confirm PRODUCTION restore', body, { danger: true })
}

export function renderRestoreAlreadyStartedPage(instanceId: string): string {
	const body = `
<header>
	<h1>Restore already started</h1>
	<p>This confirmation token already started a production restore workflow. Replays map to the same instance and are rejected as duplicates.</p>
</header>
<section class="panel danger">
	${disclosure('Workflow id', `<div class="kv"><span>Instance</span><strong>${escapeHtml(instanceId)}</strong></div>`)}
	<p>
		<a class="button" href="/restore-status?id=${encodeURIComponent(instanceId)}">View restore status</a>
		<a class="button" href="/">Dashboard</a>
	</p>
</section>`
	return layout('Restore already started', body, { danger: true })
}

export function renderRestoreStatusPage(input: {
	instanceId: string
	status: string
	progress?: ProductionRestoreProgress | null
}): string {
	const notes = input.progress?.notes ?? []
	const warnings = input.progress?.warnings ?? []
	const details = input.progress
		? JSON.stringify(input.progress, null, 2)
		: 'No progress payload yet.'
	const body = `
<header>
	<h1>Production restore status</h1>
</header>
<section class="panel danger">
	<div class="kv"><span>Status</span><strong>${escapeHtml(input.status)}</strong></div>
	${
		notes.length > 0
			? `<div class="kv"><span>Not in this backup day</span><span>${escapeHtml(notes.join('; '))}</span></div>`
			: ''
	}
	${
		warnings.length > 0
			? `<div class="kv"><span>Warnings</span><span class="bad">${escapeHtml(warnings.join('; '))}</span></div>`
			: ''
	}
	${disclosure('Workflow id and progress', `<p><code>${escapeHtml(input.instanceId)}</code></p><pre>${escapeHtml(details)}</pre>`)}
	<p>
		<a class="button" href="/restore-status?id=${encodeURIComponent(input.instanceId)}">Refresh</a>
		<a class="button" href="/">Dashboard</a>
	</p>
	<meta http-equiv="refresh" content="5;url=/restore-status?id=${encodeURIComponent(input.instanceId)}"/>
</section>`
	return layout('Production restore status', body, { danger: true })
}

export function htmlResponse(html: string, status = 200): Response {
	return new Response(html, {
		status,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
		},
	})
}
