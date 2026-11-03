import { dayBarClassName, dayBarKind, dayBarTitle } from './day-bars.ts'
import { renderFaviconLinks } from './favicon.ts'
import { uptimeWindowLabel } from './incident-rollups.ts'
import {
	cloudflareStatusPageUrl,
	sanitizeProviderIncidentShortlink,
} from './provider-incidents.ts'
import type {
	ComponentSnapshot,
	ExecuteHealthSnapshot,
	IncidentView,
	ProviderIncident,
	StatusSnapshot,
} from './status-types.ts'

/** Server-rendered public status page. A 60s reload keeps an open tab
 * tracking an ongoing incident, including swapping the status-specific
 * favicon when an incident opens or resolves: a `<noscript>` meta refresh
 * without JavaScript, otherwise an inline timer. The inline timer runs even
 * when `public/status-breakout.js` fails to load; the opt-in "while you wait"
 * game cancels it through `data-refresh-timer` because a meta refresh cannot
 * be cancelled. */

const refreshTimerScript =
	'document.documentElement.dataset.refreshTimer = String(setTimeout(() => location.reload(), 60000))'

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
}

const pageStyles = `
:root {
	color-scheme: light dark;
	--bg: #f8fafc;
	--card: #ffffff;
	--text: #0f172a;
	--muted: #64748b;
	--border: #e2e8f0;
	--ok: #16a34a;
	--down: #dc2626;
	--unknown: #94a3b8;
	--partial: #d97706;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #0b1120;
		--card: #111a2e;
		--text: #e2e8f0;
		--muted: #94a3b8;
		--border: #1e2a44;
	}
}
* { box-sizing: border-box; }
body {
	margin: 0;
	font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
	background: var(--bg);
	color: var(--text);
	line-height: 1.5;
}
main { max-width: 720px; margin: 0 auto; padding: 2rem 1rem 4rem; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
h1 { font-size: 1.5rem; margin: 0; }
.banner {
	margin: 1.25rem 0;
	padding: 1rem 1.25rem;
	border-radius: 0.75rem;
	font-weight: 600;
	color: #ffffff;
}
.banner.ok { background: var(--ok); }
.banner.down { background: var(--down); }
.banner.unknown { background: var(--unknown); }
.card {
	background: var(--card);
	border: 1px solid var(--border);
	border-radius: 0.75rem;
	padding: 1rem 1.25rem;
	margin-bottom: 1rem;
	overflow: hidden;
	min-width: 0;
}
.component { display: flex; flex-direction: column; gap: 0.5rem; min-width: 0; }
.component-header { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
.component-name { font-weight: 600; }
.component-meta { color: var(--muted); font-size: 0.85rem; }
.dot { display: inline-block; width: 0.6rem; height: 0.6rem; border-radius: 50%; margin-right: 0.5rem; vertical-align: baseline; }
.dot.operational { background: var(--ok); }
.dot.down { background: var(--down); }
.dot.unknown { background: var(--unknown); }
/* 90 day bars: allow shrink below 2px so the row fits phone content widths
 * (iPhone ~321px after padding; min-width:2px + gaps overflowed). */
.bars {
	display: flex;
	gap: 2px;
	height: 2rem;
	align-items: stretch;
	min-width: 0;
	overflow: hidden;
}
.bar {
	flex: 1 1 0;
	border-radius: 1px;
	background: var(--ok);
	min-width: 0;
}
.bar.empty { background: var(--border); }
.bar.partial { background: var(--partial); }
.bar.bad { background: var(--down); }
.bars-legend {
	display: flex;
	justify-content: space-between;
	gap: 0.5rem;
	color: var(--muted);
	font-size: 0.75rem;
	min-width: 0;
}
.bars-legend span { min-width: 0; overflow-wrap: anywhere; }
.incident { border-left: 3px solid var(--down); padding-left: 0.75rem; margin: 0.75rem 0; }
.incident.resolved { border-left-color: var(--ok); }
.incident-title { font-weight: 600; }
.incident-meta { color: var(--muted); font-size: 0.85rem; }
.retrospective { margin-top: 0.5rem; }
.retrospective summary {
	cursor: pointer;
	color: var(--muted);
	font-size: 0.85rem;
	font-weight: 600;
}
.retrospective-section { margin: 0.6rem 0 0; }
.retrospective-section h3 {
	margin: 0 0 0.2rem;
	font-size: 0.8rem;
	text-transform: uppercase;
	letter-spacing: 0.03em;
	color: var(--muted);
}
.retrospective-section p,
.retrospective-section li { margin: 0; white-space: pre-wrap; }
.retrospective-section ol { margin: 0; padding-left: 1.1rem; }
.provider-section {
	margin: 2rem 0 1rem;
	padding: 1rem 1.25rem;
	border: 1px dashed var(--border);
	border-radius: 0.75rem;
	background: color-mix(in srgb, var(--card) 85%, var(--partial));
}
.provider-section h2 { margin: 0 0 0.35rem; }
.provider-lead { color: var(--muted); font-size: 0.85rem; margin: 0 0 0.75rem; }
.provider-incident {
	border-left: 3px solid var(--partial);
	border-radius: 0 0.5rem 0.5rem 0;
	padding: 0.5rem 0.75rem;
	margin: 0.75rem 0 0;
	background: var(--card);
}
.provider-incident-title { font-weight: 600; }
.provider-incident-meta { color: var(--muted); font-size: 0.85rem; }
.provider-incident a { color: inherit; }
h2 { font-size: 1.1rem; margin: 2rem 0 0.75rem; }
footer { margin-top: 2.5rem; color: var(--muted); font-size: 0.85rem; }
footer a { color: inherit; }
.play-button {
	display: block;
	width: 100%;
	margin: -0.25rem 0 1.25rem;
	padding: 0.7rem 1rem;
	border: 1px dashed var(--muted);
	border-radius: 0.75rem;
	background: var(--card);
	color: var(--text);
	font: inherit;
	font-weight: 600;
	cursor: pointer;
}
.play-button:hover { border-style: solid; }
.play-button[hidden] { display: none; }
.footer-play {
	padding: 0;
	border: 0;
	background: none;
	color: inherit;
	font: inherit;
	text-decoration: underline;
	cursor: pointer;
}
html.breakout-active,
html.breakout-active body { overflow: hidden; }
html.breakout-active body { user-select: none; -webkit-user-select: none; }
html.breakout-active main {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(min(22rem, 100%), 1fr));
	gap: 0.75rem;
	align-content: start;
	max-width: none;
	margin: 0;
	padding: 1rem;
	transform-origin: top left;
}
html.breakout-active main > * { margin: 0; }
html.breakout-active main > :is(header, .banner, h2, footer, p, .provider-section) { grid-column: 1 / -1; }
html.breakout-active .bars { gap: 1px; }
.breakout-canvas { position: fixed; inset: 0; z-index: 10; touch-action: none; cursor: none; }
.breakout-hud {
	position: fixed;
	inset: auto 0 0;
	z-index: 11;
	display: flex;
	flex-wrap: wrap;
	gap: 0.25rem 1.25rem;
	align-items: center;
	padding: 0.4rem 1rem;
	color: var(--muted);
	font-size: 0.8rem;
	pointer-events: none;
}
.breakout-live { margin-left: auto; }
.breakout-hud button,
.breakout-panel button,
.breakout-toast button {
	pointer-events: auto;
	padding: 0.3rem 0.7rem;
	border: 1px solid var(--border);
	border-radius: 0.5rem;
	background: var(--card);
	color: var(--text);
	font: inherit;
	cursor: pointer;
}
.breakout-panel,
.breakout-toast {
	position: fixed;
	left: 50%;
	z-index: 12;
	transform: translateX(-50%);
	background: var(--card);
	border: 1px solid var(--border);
	border-radius: 0.75rem;
	box-shadow: 0 20px 50px rgb(0 0 0 / 0.35);
}
.breakout-panel { top: 30%; width: min(24rem, 90vw); padding: 1.25rem 1.5rem; text-align: center; }
.breakout-panel h2 { margin: 0 0 0.25rem; }
.breakout-panel p { margin: 0 0 1rem; color: var(--muted); }
.breakout-actions { display: flex; gap: 0.5rem; justify-content: center; }
.breakout-panel .breakout-primary { background: var(--text); color: var(--bg); border-color: var(--text); }
.breakout-toast {
	top: 1rem;
	width: max-content;
	max-width: 90vw;
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem 0.75rem;
	align-items: center;
	padding: 0.6rem 0.9rem;
	border-color: var(--ok);
	font-weight: 600;
}
.breakout-panel[hidden],
.breakout-toast[hidden] { display: none; }
`

function bannerFor(snapshot: StatusSnapshot): { label: string; kind: string } {
	switch (snapshot.overallStatus) {
		case 'operational':
			return { label: 'All systems operational', kind: 'ok' }
		case 'down':
			return { label: 'Some systems are experiencing problems', kind: 'down' }
		case 'unknown':
			return { label: 'Status data is not available yet', kind: 'unknown' }
		default: {
			snapshot.overallStatus satisfies never
			throw new Error(
				`Unknown overall status: ${String(snapshot.overallStatus)}`,
			)
		}
	}
}

function renderDayBars(component: ComponentSnapshot): string {
	const bars = component.days
		.map((day) => {
			const kind = dayBarKind(day)
			return `<div class="${dayBarClassName(kind)}" title="${escapeHtml(dayBarTitle(day))}"></div>`
		})
		.join('')
	return `<div class="bars">${bars}</div>`
}

function renderExecuteHealth(executeHealth: ExecuteHealthSnapshot): string {
	const statusLabel =
		executeHealth.status === 'recent'
			? 'Recently verified'
			: 'Not recently exercised'
	const source =
		executeHealth.source === 'organic'
			? 'organic traffic'
			: executeHealth.source === 'synthetic'
				? 'hourly synthetic'
				: 'no source yet'
	const verified =
		executeHealth.lastVerifiedAt === null
			? 'Last verified time is unknown'
			: `Last verified ${escapeHtml(executeHealth.lastVerifiedAt)}`
	return `<div class="card component">
	<div class="component-header">
		<span class="component-name"><span class="dot ${executeHealth.status === 'recent' ? 'operational' : 'unknown'}"></span>MCP execute</span>
		<span class="component-meta">${escapeHtml(statusLabel)} · ${escapeHtml(source)}</span>
	</div>
	<p class="component-meta">${escapeHtml(executeHealth.detail)}</p>
	<p class="component-meta">${verified}</p>
</div>`
}

function renderComponent(component: ComponentSnapshot): string {
	const statusLabel =
		component.status === 'operational'
			? 'Operational'
			: component.status === 'down'
				? 'Down'
				: 'Unknown'
	const uptime =
		component.uptimePct === null
			? 'no data yet'
			: `${component.uptimePct.toFixed(2)}% uptime (${uptimeWindowLabel(component.days)})`
	const latency =
		component.status === 'operational' && component.latencyMs !== null
			? ` · ${component.latencyMs}ms`
			: ''
	const firstDay = component.days.at(0)?.day ?? ''
	const lastDay = component.days.at(-1)?.day ?? ''
	return `<div class="card component">
	<div class="component-header">
		<span class="component-name"><span class="dot ${component.status}"></span>${escapeHtml(component.name)}</span>
		<span class="component-meta">${escapeHtml(statusLabel)}${latency}</span>
	</div>
	${renderDayBars(component)}
	<div class="bars-legend"><span>${escapeHtml(firstDay)}</span><span>${escapeHtml(uptime)}</span><span>${escapeHtml(lastDay)}</span></div>
</div>`
}

function renderRetrospective(incident: IncidentView): string {
	const retrospective = incident.retrospective
	if (!retrospective) return ''
	const timeline = retrospective.timeline
		.map(
			(entry) =>
				`<li><span class="incident-meta">${escapeHtml(entry.at)}</span> — ${escapeHtml(entry.note)}</li>`,
		)
		.join('')
	return `<details class="retrospective">
	<summary>Retrospective</summary>
	<div class="retrospective-section"><h3>What happened</h3><p>${escapeHtml(retrospective.whatHappened)}</p></div>
	<div class="retrospective-section"><h3>Impact</h3><p>${escapeHtml(retrospective.impact)}</p></div>
	<div class="retrospective-section"><h3>Timeline</h3><ol>${timeline}</ol></div>
	<div class="retrospective-section"><h3>Cause</h3><p>${escapeHtml(retrospective.cause)}</p></div>
	<div class="retrospective-section"><h3>What we did</h3><p>${escapeHtml(retrospective.whatWeDid)}</p></div>
	<div class="retrospective-section"><h3>What we will change</h3><p>${escapeHtml(retrospective.whatWeWillChange)}</p></div>
	<div class="incident-meta">Published ${escapeHtml(retrospective.publishedAt)}</div>
</details>`
}

function renderIncident(incident: IncidentView): string {
	const resolved = incident.resolvedAt !== null
	const detail = incident.detail ? ` — ${escapeHtml(incident.detail)}` : ''
	const timing = resolved
		? `${escapeHtml(incident.startedAt)} → ${escapeHtml(incident.resolvedAt ?? '')}`
		: `since ${escapeHtml(incident.startedAt)}`
	return `<div class="incident${resolved ? ' resolved' : ''}">
	<div class="incident-title">${escapeHtml(incident.componentName)} ${resolved ? 'outage (resolved)' : 'is down'}${detail}</div>
	<div class="incident-meta">${timing}</div>
	${renderRetrospective(incident)}
</div>`
}

function renderProviderIncident(incident: ProviderIncident): string {
	const components =
		incident.affectedComponents.length > 0
			? ` · affects ${escapeHtml(incident.affectedComponents.join(', '))}`
			: ''
	const href = sanitizeProviderIncidentShortlink(incident.shortlink)
	return `<div class="provider-incident">
	<div class="provider-incident-title">${escapeHtml(incident.name)}</div>
	<div class="provider-incident-meta">${escapeHtml(incident.status)} · ${escapeHtml(incident.impact)} impact${components}</div>
	<div class="provider-incident-meta"><a href="${escapeHtml(href)}">Cloudflare status</a> · updated ${escapeHtml(incident.updatedAt)}</div>
</div>`
}

/** Public GitHub repository for the main kody worker (production deploys). */
const productionRepo = 'kody-hq/kody'

function productionCommitLink(commitSha: string): string {
	const shortSha = commitSha.slice(0, 7)
	const href = `https://github.com/${productionRepo}/commit/${escapeHtml(commitSha)}`
	return `<a href="${href}">${escapeHtml(shortSha)}</a>`
}

function renderProductionCommits(snapshot: StatusSnapshot): string {
	const parts: Array<string> = []
	if (snapshot.productionCommit) {
		parts.push(`app ${productionCommitLink(snapshot.productionCommit)}`)
	}
	if (snapshot.runtimeCommit) {
		parts.push(`runtime ${productionCommitLink(snapshot.runtimeCommit)}`)
	}
	if (snapshot.jobsCommit) {
		parts.push(`jobs ${productionCommitLink(snapshot.jobsCommit)}`)
	}
	if (parts.length === 0) return ''
	return `Production ${parts.join(' · ')} · `
}

function renderProviderIncidentsSection(
	incidents: Array<ProviderIncident> | null | undefined,
): string {
	if (incidents == null || incidents.length === 0) return ''
	return `<section class="provider-section" aria-label="Provider incidents from Cloudflare">
	<h2>Provider incidents (Cloudflare)</h2>
	<p class="provider-lead">Declared by Cloudflare on <a href="${escapeHtml(cloudflareStatusPageUrl)}">cloudflarestatus.com</a>. Separate from kody's measured component health — for context only.</p>
	${incidents.map(renderProviderIncident).join('\n')}
</section>`
}

const statusPageUrl = 'https://status.kody.codes/'

/** Static HTML for origin-edge maintenance. No Durable Object or D1. */
export function renderMaintenancePage(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Kody is in maintenance</title>
${renderFaviconLinks('unknown')}
<style>${pageStyles}</style>
</head>
<body>
<main>
	<header>
		<h1>Kody is in maintenance</h1>
	</header>
	<div class="banner unknown">Service restore in progress</div>
	<div class="card">
		<p>Kody is in maintenance. We are restoring service; nothing you need to do. Check <a href="${statusPageUrl}">status.kody.codes</a> for updates.</p>
	</div>
</main>
</body>
</html>`
}

/** Controlled 503 HTML when the status Durable Object is unavailable. */
export function renderStatusUnavailablePage(message: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="refresh" content="30" />
<title>Kody status</title>
${renderFaviconLinks('unknown')}
</head>
<body>
<main>
	<h1>kody status</h1>
	<p>${escapeHtml(message)} This page retries automatically.</p>
</main>
</body>
</html>`
}

export function renderStatusPage(snapshot: StatusSnapshot): string {
	const banner = bannerFor(snapshot)
	const components = snapshot.components.map(renderComponent).join('\n')
	const openIncidents =
		snapshot.openIncidents.length > 0
			? `<h2>Open incidents</h2>${snapshot.openIncidents.map(renderIncident).join('\n')}`
			: ''
	const providerIncidents = renderProviderIncidentsSection(
		snapshot.providerIncidents,
	)
	const recentIncidents =
		snapshot.recentIncidents.length > 0
			? `<h2>Past incidents</h2>${snapshot.recentIncidents.map(renderIncident).join('\n')}`
			: '<h2>Past incidents</h2><p class="component-meta">No incidents recorded in the last 90 days.</p>'
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<noscript><meta http-equiv="refresh" content="60" /></noscript>
<script>${refreshTimerScript}</script>
<title>Kody status</title>
${renderFaviconLinks(snapshot.overallStatus)}
<style>${pageStyles}</style>
<script type="module" src="/status-breakout.js"></script>
</head>
<body data-overall-status="${snapshot.overallStatus}">
<main>
	<header>
		<h1>kody status</h1>
		<span class="component-meta">Updated ${escapeHtml(snapshot.generatedAt)}</span>
	</header>
	<div class="banner ${banner.kind}">${escapeHtml(banner.label)}</div>
	<button type="button" class="play-button" data-breakout-start hidden>Play while you wait</button>
	${renderExecuteHealth(snapshot.executeHealth)}
	${components}
	${openIncidents}
	${providerIncidents}
	${recentIncidents}
	<footer>
		${renderProductionCommits(snapshot)}Probes run every minute from an independently deployed worker.
		<a href="https://kody.codes">kody.codes</a> ·
		<a href="/status.json">JSON</a><span data-breakout-footer-start hidden>
		· <button type="button" class="footer-play">Play Breakout</button></span>
	</footer>
</main>
</body>
</html>`
}
