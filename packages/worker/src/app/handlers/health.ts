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
		if (prefersHtml(request.headers.get('Accept'))) {
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

function renderHealthHtml(report: HealthReport) {
	const commitLink = report.commit
		? `<a href="${escapeHtml(report.commit.url)}">${escapeHtml(report.commit.sha)}</a>`
		: 'unset'
	const pullRequestLink = report.pullRequest
		? `<a href="${escapeHtml(report.pullRequest.url)}">#${String(report.pullRequest.number)}${report.pullRequest.title ? ` ${escapeHtml(report.pullRequest.title)}` : ''}</a>`
		: 'none'
	const deployLink = report.deploy?.runUrl
		? `<a href="${escapeHtml(report.deploy.runUrl)}">${escapeHtml(report.deploy.runUrl)}</a>`
		: 'unset'
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kody health</title>
<style>
body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem auto; max-width: 48rem; padding: 0 1.25rem; line-height: 1.5; }
dt { font-weight: 600; margin-top: 1rem; }
dd { margin: 0.25rem 0 0; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
a { overflow-wrap: anywhere; }
</style>
</head>
<body>
<h1>ok</h1>
<dl>
<dt>Commit</dt>
<dd>${commitLink}</dd>
<dt>Commit message</dt>
<dd><pre>${escapeHtml(report.commit?.message ?? 'unset')}</pre></dd>
<dt>Committed</dt>
<dd>${escapeHtml(report.commit?.committedAt ?? 'unset')}</dd>
<dt>Pull request</dt>
<dd>${pullRequestLink}</dd>
<dt>Deployed</dt>
<dd>${escapeHtml(report.deploy?.deployedAt ?? 'unset')}</dd>
<dt>Environment</dt>
<dd>${escapeHtml(report.deploy?.environment ?? 'unset')}</dd>
<dt>Workflow / job</dt>
<dd>${escapeHtml(report.deploy?.workflow ?? 'unset')} / ${escapeHtml(report.deploy?.job ?? 'unset')}</dd>
<dt>Deploy job</dt>
<dd>${deployLink}</dd>
</dl>
</body>
</html>
`
}
