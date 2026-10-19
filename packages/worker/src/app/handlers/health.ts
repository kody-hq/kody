import { escapeHtml } from '@kody-internal/shared/escape-html.ts'
import {
	buildHealthReport,
	prefersHtml,
	type HealthReport,
} from '#worker/deploy-info.ts'
import { type AppEnv } from '#worker/env-schema.ts'

type HealthEnv = {
	APP_COMMIT_SHA: AppEnv['APP_COMMIT_SHA']
	APP_DEPLOY_INFO: AppEnv['APP_DEPLOY_INFO']
}

export function createHealthHandler(appEnv: HealthEnv) {
	return async ({ request }: { request: Request }) => {
		const report = buildHealthReport(appEnv)
		const commitSha = report.commitSha ?? 'unknown'
		const headers = {
			'Cache-Control': 'no-store',
			'X-App-Commit-Sha': commitSha,
		}
		const forceJson = new URL(request.url).searchParams.get('format') === 'json'
		if (!forceJson && prefersHtml(request.headers.get('Accept'))) {
			return new Response(renderHealthHtml(report), {
				headers: {
					...headers,
					'Content-Type': 'text/html; charset=utf-8',
				},
			})
		}
		return Response.json(report, { headers })
	}
}

/** Absolute http(s) URL safe for href, otherwise null. */
export function safeHttpHref(raw: string): string | null {
	try {
		const url = new URL(raw)
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
		return url.href
	} catch {
		return null
	}
}

function linkOrText(href: string | null | undefined, label: string) {
	const safe = href ? safeHttpHref(href) : null
	const escapedLabel = escapeHtml(label)
	if (!safe) return escapedLabel
	return `<a href="${escapeHtml(safe)}" rel="noopener noreferrer">${escapedLabel}</a>`
}

function displayOrUnset(value: string | null | undefined) {
	return escapeHtml(value?.trim() ? value : 'unset')
}

export function renderHealthHtml(report: HealthReport) {
	const healthy = report.ok
	const statusLabel = healthy ? 'Healthy' : 'Unhealthy'
	const statusClass = healthy ? 'status-ok' : 'status-bad'
	const commitLabel = report.commit?.sha ?? report.commitSha ?? 'unset'
	const commitLink = linkOrText(report.commit?.url, commitLabel)
	const pullRequestLabel = report.pullRequest
		? `#${String(report.pullRequest.number)}${report.pullRequest.title ? ` ${report.pullRequest.title}` : ''}`
		: 'none'
	const pullRequestLink = report.pullRequest
		? linkOrText(report.pullRequest.url, pullRequestLabel)
		: escapeHtml('none')
	const deployRunLabel = report.deploy?.runUrl ?? 'unset'
	const deployLink = report.deploy?.runUrl
		? linkOrText(report.deploy.runUrl, deployRunLabel)
		: escapeHtml('unset')
	const workflow = report.deploy?.workflow ?? 'unset'
	const job = report.deploy?.job ?? 'unset'
	const rawJson = escapeHtml(JSON.stringify(report, null, 2))
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Kody health</title>
<style>
@font-face {
	font-family: 'Bricolage Grotesque';
	font-style: normal;
	font-weight: 400 800;
	font-stretch: 100%;
	font-display: swap;
	src: url('/fonts/bricolage-grotesque-latin.woff2') format('woff2');
}
@font-face {
	font-family: 'Wix Madefor Text';
	font-style: normal;
	font-weight: 400 800;
	font-display: swap;
	src: url('/fonts/wix-madefor-text-latin.woff2') format('woff2');
}
:root {
	color-scheme: light dark;
	--color-primary: oklch(0.54 0.18 145);
	--color-primary-text: oklch(0.455 0.17 145);
	--color-background: oklch(0.93 0.004 250);
	--color-surface: oklch(0.975 0.002 250);
	--color-text: oklch(0.22 0.012 260);
	--color-text-muted: oklch(0.44 0.014 260);
	--color-border: oklch(0.84 0.008 250);
	--color-danger: oklch(0.535 0.19 25);
	--color-on-danger: oklch(0.985 0.005 25);
	--font-display: 'Bricolage Grotesque', system-ui, sans-serif;
	--font-body: 'Wix Madefor Text', system-ui, sans-serif;
	--font-mono: ui-monospace, 'SF Mono', Menlo, monospace;
	--radius-md: 0.5rem;
	--radius-lg: 0.75rem;
	--radius-full: 999px;
	--shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
}
@media (prefers-color-scheme: dark) {
	:root {
		color-scheme: dark;
		--color-primary: oklch(0.72 0.205 145);
		--color-primary-text: oklch(0.75 0.2 145);
		--color-background: oklch(0.19 0.008 255);
		--color-surface: oklch(0.235 0.01 255);
		--color-text: oklch(0.945 0.005 250);
		--color-text-muted: oklch(0.72 0.01 255);
		--color-border: oklch(0.33 0.01 255);
		--color-danger: oklch(0.75 0.16 25);
		--color-on-danger: oklch(0.2 0.05 25);
		--shadow-sm: 0 1px 2px 0 rgb(255 255 255 / 0.05);
	}
}
* { box-sizing: border-box; }
body {
	margin: 0;
	min-height: 100vh;
	font-family: var(--font-body);
	font-size: 1rem;
	line-height: 1.62;
	color: var(--color-text);
	background:
		radial-gradient(ellipse 80% 50% at 50% -10%, oklch(from var(--color-primary) l c h / 0.12), transparent 70%),
		var(--color-background);
}
main {
	max-width: 40rem;
	margin: 0 auto;
	padding: clamp(2rem, 8vh, 4rem) 1.25rem 3rem;
}
.brand {
	font-family: var(--font-display);
	font-size: 1.125rem;
	font-weight: 700;
	letter-spacing: -0.02em;
	color: var(--color-primary-text);
	margin: 0 0 1.25rem;
}
.panel {
	background: var(--color-surface);
	border: 1px solid var(--color-border);
	border-radius: var(--radius-lg);
	box-shadow: var(--shadow-sm);
	padding: 1.5rem 1.35rem 1.35rem;
}
.header {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.75rem 1rem;
	margin-bottom: 1.25rem;
}
h1 {
	font-family: var(--font-display);
	font-size: clamp(1.75rem, 4vw, 2.25rem);
	font-weight: 700;
	letter-spacing: -0.03em;
	line-height: 1.15;
	margin: 0;
}
.status {
	display: inline-flex;
	align-items: center;
	gap: 0.4rem;
	padding: 0.28rem 0.7rem;
	border-radius: var(--radius-full);
	font-size: 0.8125rem;
	font-weight: 600;
	letter-spacing: 0.01em;
}
.status::before {
	content: '';
	width: 0.45rem;
	height: 0.45rem;
	border-radius: 50%;
	background: currentColor;
}
.status-ok {
	color: var(--color-primary-text);
	background: oklch(from var(--color-primary) l c h / 0.12);
}
.status-bad {
	color: var(--color-danger);
	background: oklch(from var(--color-danger) l c h / 0.12);
}
dl {
	display: grid;
	grid-template-columns: minmax(7rem, 9.5rem) 1fr;
	gap: 0.65rem 1rem;
	margin: 0;
}
dt {
	margin: 0;
	font-size: 0.8125rem;
	font-weight: 600;
	color: var(--color-text-muted);
	padding-top: 0.15rem;
}
dd {
	margin: 0;
	min-width: 0;
	overflow-wrap: anywhere;
}
dd pre {
	margin: 0;
	font-family: var(--font-mono);
	font-size: 0.8125rem;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	line-height: 1.5;
}
a {
	color: var(--color-primary-text);
	text-decoration-thickness: 1px;
	text-underline-offset: 0.15em;
}
a:hover { text-decoration-thickness: 2px; }
.meta {
	display: flex;
	flex-wrap: wrap;
	gap: 0.75rem 1.25rem;
	margin-top: 1.25rem;
	padding-top: 1rem;
	border-top: 1px solid var(--color-border);
	font-size: 0.875rem;
	color: var(--color-text-muted);
}
.meta a { font-weight: 500; }
details {
	margin-top: 0.85rem;
	border-radius: var(--radius-md);
	border: 1px solid var(--color-border);
	background: var(--color-background);
}
summary {
	cursor: pointer;
	padding: 0.65rem 0.85rem;
	font-size: 0.875rem;
	font-weight: 500;
	color: var(--color-text-muted);
	list-style: none;
}
summary::-webkit-details-marker { display: none; }
summary::before {
	content: '▸';
	display: inline-block;
	margin-right: 0.4rem;
	transition: transform 120ms ease;
}
details[open] summary::before { transform: rotate(90deg); }
details pre {
	margin: 0;
	padding: 0 0.85rem 0.85rem;
	font-family: var(--font-mono);
	font-size: 0.75rem;
	line-height: 1.5;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	color: var(--color-text);
}
@media (max-width: 520px) {
	dl { grid-template-columns: 1fr; gap: 0.2rem; }
	dt { padding-top: 0.55rem; }
	dt:first-child { padding-top: 0; }
}
</style>
</head>
<body>
<main>
<p class="brand">Kody</p>
<section class="panel" aria-labelledby="health-heading">
<div class="header">
<h1 id="health-heading">Health</h1>
<span class="status ${statusClass}" role="status">${escapeHtml(statusLabel)}</span>
</div>
<dl>
<dt>Commit</dt>
<dd>${commitLink}</dd>
<dt>Commit message</dt>
<dd><pre>${displayOrUnset(report.commit?.message)}</pre></dd>
<dt>Committed</dt>
<dd>${displayOrUnset(report.commit?.committedAt)}</dd>
<dt>Pull request</dt>
<dd>${pullRequestLink}</dd>
<dt>Deployed</dt>
<dd>${displayOrUnset(report.deploy?.deployedAt)}</dd>
<dt>Environment</dt>
<dd>${displayOrUnset(report.deploy?.environment)}</dd>
<dt>Workflow / job</dt>
<dd>${escapeHtml(workflow)} / ${escapeHtml(job)}</dd>
<dt>Deploy job</dt>
<dd>${deployLink}</dd>
</dl>
<div class="meta">
<a href="?format=json">View as JSON</a>
</div>
<details>
<summary>Raw JSON</summary>
<pre>${rawJson}</pre>
</details>
</section>
</main>
</body>
</html>
`
}
