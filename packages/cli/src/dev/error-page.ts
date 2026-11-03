/**
 * Dev-only error responses served by the `kody dev` proxy for build failures
 * and uncaught handler errors. HTML for browsers, plain text for everyone else
 * (curl, agents, `kody dev fetch`).
 */

import { type IncomingMessage, type ServerResponse } from 'node:http'

type DevErrorKind = 'build' | 'runtime'

export type DevErrorView = {
	kind: DevErrorKind
	title: string
	/** Preformatted body: diagnostics with code frames, or a mapped stack. */
	detail: string
	/** `METHOD /path` for runtime errors. */
	request?: string
}

function wantsHtml(req: IncomingMessage): boolean {
	const accept = req.headers.accept ?? ''
	return /\btext\/html\b/.test(accept)
}

export function sendDevError(
	req: IncomingMessage,
	res: ServerResponse,
	status: number,
	view: DevErrorView,
	options: { htmlTail?: string } = {},
): void {
	if (res.headersSent) {
		res.end()
		return
	}
	const headers = {
		'cache-control': 'no-store',
		'x-kody-dev-error': view.kind,
	}
	if (wantsHtml(req)) {
		res.writeHead(status, {
			...headers,
			'content-type': 'text/html; charset=utf-8',
		})
		res.end(renderDevErrorPage(view) + (options.htmlTail ?? ''))
		return
	}
	res.writeHead(status, {
		...headers,
		'content-type': 'text/plain; charset=utf-8',
	})
	res.end(
		`kody dev ${view.kind} error${view.request ? ` (${view.request})` : ''}\n\n${view.detail}\n`,
	)
}

function renderDevErrorPage(view: DevErrorView): string {
	const label = view.kind === 'build' ? 'Build error' : 'Runtime error'
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(label)} · kody dev</title>
<style>
	:root { color-scheme: dark; }
	body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; background: #1a1015; color: #f5e9ee; }
	main { max-width: 960px; margin: 0 auto; padding: 32px 24px; }
	.label { display: inline-block; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: #ff8fab; }
	h1 { font-size: 20px; margin: 8px 0 20px; word-break: break-word; }
	pre { margin: 0; padding: 16px; overflow: auto; background: #0e080b; border: 1px solid #3a2530; border-radius: 8px; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre; }
	p { color: #bfa9b3; font-size: 13px; }
</style>
</head>
<body>
<main>
<span class="label">${escapeHtml(label)}</span>
<h1>${escapeHtml(view.title)}</h1>${view.request ? `\n<p>${escapeHtml(view.request)}</p>` : ''}
<pre>${escapeHtml(view.detail)}</pre>
<p>Served by <code>kody dev</code> only; published apps never see this page.</p>
</main>
</body>
</html>
`
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}
