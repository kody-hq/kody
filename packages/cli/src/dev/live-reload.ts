/**
 * Live reload for `kody dev`: an SSE stream at {@link liveReloadEventsPath}, a
 * tiny client injected into HTML responses that reloads after each swap, and
 * an error overlay for build and runtime errors. No HMR: a reload re-renders
 * the page from the new build.
 */

import { type IncomingMessage, type ServerResponse } from 'node:http'
import { type DevErrorView } from './error-page.js'

export const liveReloadEventsPath = '/__kody/dev/events'
export const liveReloadClientPath = '/__kody/dev/client.js'

export const liveReloadScriptTag = `<script type="module" src="${liveReloadClientPath}"></script>`

const keepAliveMs = 15_000

export type LiveReloadMessage =
	| { event: 'reload'; data: { buildId: number } }
	| { event: 'build_error'; data: DevErrorView }
	| { event: 'runtime_error'; data: DevErrorView }

export type LiveReloadHub = {
	/** Serve the SSE stream; sends `hello` with the current build first. */
	handleEvents: (req: IncomingMessage, res: ServerResponse) => void
	broadcast: (message: LiveReloadMessage) => void
	clientCount: () => number
	close: () => void
}

export function createLiveReloadHub(input: {
	state: () => { buildId: number | null; error: DevErrorView | null }
}): LiveReloadHub {
	const clients = new Set<ServerResponse>()
	const send = (res: ServerResponse, event: string, data: unknown) => {
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
	}
	const keepAlive = setInterval(() => {
		for (const res of clients) res.write(': keep-alive\n\n')
	}, keepAliveMs)
	keepAlive.unref()
	return {
		handleEvents: (req, res) => {
			res.writeHead(200, {
				'content-type': 'text/event-stream; charset=utf-8',
				'cache-control': 'no-store',
				connection: 'keep-alive',
			})
			res.write('retry: 500\n\n')
			send(res, 'hello', input.state())
			clients.add(res)
			req.on('close', () => clients.delete(res))
		},
		broadcast: (message) => {
			for (const res of clients) send(res, message.event, message.data)
		},
		clientCount: () => clients.size,
		close: () => {
			clearInterval(keepAlive)
			for (const res of clients) res.end()
			clients.clear()
		},
	}
}

/** Insert the client tag before `</head>`, else `</body>`, else at the end. */
export function injectLiveReloadScript(html: string): string {
	if (html.includes(liveReloadClientPath)) return html
	for (const pattern of [/<\/head\s*>/i, /<\/body\s*>/i]) {
		const match = pattern.exec(html)
		if (match) {
			return `${html.slice(0, match.index)}${liveReloadScriptTag}${html.slice(match.index)}`
		}
	}
	return `${html}${liveReloadScriptTag}`
}

/**
 * Only page loads that ask for HTML (browsers send `Accept: text/html`); agent
 * and `kody dev fetch` requests get the app's bytes untouched.
 */
export function shouldInjectLiveReload(input: {
	method: string | undefined
	accept: string | undefined
	status: number
	headers: Record<string, string | Array<string> | number | undefined>
}): boolean {
	if (input.method === 'HEAD') return false
	if (!/\btext\/html\b/i.test(input.accept ?? '')) return false
	if (input.status === 204 || input.status === 304 || input.status < 200)
		return false
	const contentType = String(input.headers['content-type'] ?? '')
	if (!/^\s*text\/html\b/i.test(contentType)) return false
	const encoding = String(input.headers['content-encoding'] ?? 'identity')
		.trim()
		.toLowerCase()
	return encoding === '' || encoding === 'identity'
}

export const liveReloadClientSource = `
const eventsUrl = ${JSON.stringify(liveReloadEventsPath)};
let buildId = null;
let overlay = null;

function hideOverlay() {
	overlay?.remove();
	overlay = null;
}

function showOverlay(view) {
	if (globalThis.__kodyDevErrorPage) return;
	hideOverlay();
	const host = document.createElement('kody-dev-overlay');
	const root = host.attachShadow({ mode: 'open' });
	const label = view.kind === 'build' ? 'Build error' : 'Runtime error';
	// Keep CSS out of the text tree (page-text readers / textContent walkers).
	const sheet = new CSSStyleSheet();
	sheet.replaceSync(\`
	.backdrop { position: fixed; inset: 0; z-index: 2147483647; background: rgba(10, 4, 7, .82); display: flex; align-items: flex-start; justify-content: center; overflow: auto; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; }
	.panel { margin: 48px 16px; max-width: 960px; width: 100%; background: #1a1015; color: #f5e9ee; border: 1px solid #3a2530; border-radius: 10px; padding: 20px 24px; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
	.top { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
	.label { font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: #ff8fab; }
	button { all: unset; cursor: pointer; color: #bfa9b3; font-size: 20px; line-height: 1; padding: 4px 8px; border-radius: 6px; }
	button:hover, button:focus-visible { background: #2a1a22; color: #fff; }
	h1 { font-size: 18px; margin: 8px 0 4px; word-break: break-word; }
	.request { color: #bfa9b3; font-size: 13px; margin: 0 0 12px; }
	pre { margin: 12px 0 0; padding: 14px; overflow: auto; background: #0e080b; border: 1px solid #3a2530; border-radius: 8px; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre; }
	.hint { color: #bfa9b3; font-size: 12px; margin-top: 12px; }
\`);
	root.adoptedStyleSheets = [sheet];
	root.innerHTML = \`
<div class="backdrop" role="alertdialog" aria-modal="true" aria-labelledby="kody-dev-title">
	<div class="panel">
		<div class="top"><span class="label"></span><button type="button" aria-label="Dismiss">×</button></div>
		<h1 id="kody-dev-title"></h1>
		<p class="request"></p>
		<pre></pre>
		<p class="hint">Fix it and save. The page reloads on the next good build. Esc dismisses.</p>
	</div>
</div>\`;
	root.querySelector('.label').textContent = label;
	root.querySelector('h1').textContent = view.title;
	const request = root.querySelector('.request');
	if (view.request) request.textContent = view.request;
	else request.remove();
	root.querySelector('pre').textContent = view.detail;
	root.querySelector('button').addEventListener('click', hideOverlay);
	document.documentElement.appendChild(host);
	overlay = host;
	root.querySelector('button').focus();
}

addEventListener('keydown', (event) => {
	if (event.key === 'Escape') hideOverlay();
});

function connect() {
	const source = new EventSource(eventsUrl);
	source.addEventListener('hello', (event) => {
		const state = JSON.parse(event.data);
		if (buildId !== null && state.buildId !== null && state.buildId !== buildId) {
			location.reload();
			return;
		}
		buildId = state.buildId;
		if (state.error) showOverlay(state.error);
	});
	source.addEventListener('reload', () => location.reload());
	source.addEventListener('build_error', (event) => showOverlay(JSON.parse(event.data)));
	source.addEventListener('runtime_error', (event) => showOverlay(JSON.parse(event.data)));
}

connect();
`.trimStart()
