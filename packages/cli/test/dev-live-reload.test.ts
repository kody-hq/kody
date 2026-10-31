import assert from 'node:assert/strict'
import { request } from 'node:http'
import { test } from 'node:test'
import {
	injectLiveReloadScript,
	liveReloadClientSource,
	liveReloadScriptTag,
	shouldInjectLiveReload,
} from '../src/dev/live-reload.js'
import { waitFor, withDevServer } from './dev-server-harness.js'

test('error overlay CSS uses adoptedStyleSheets, not a light-DOM <style> text node', () => {
	assert.match(liveReloadClientSource, /adoptedStyleSheets/)
	assert.match(liveReloadClientSource, /CSSStyleSheet/)
	assert.match(liveReloadClientSource, /replaceSync/)
	assert.doesNotMatch(liveReloadClientSource, /<style>/)
	assert.doesNotMatch(liveReloadClientSource, /<\/style>/)
})

test('injectLiveReloadScript prefers </head>, then </body>, then appends once', () => {
	assert.equal(
		injectLiveReloadScript(
			'<html><head><title>x</title></head><body></body></html>',
		),
		`<html><head><title>x</title>${liveReloadScriptTag}</head><body></body></html>`,
	)
	assert.equal(
		injectLiveReloadScript('<body>hi</BODY>'),
		`<body>hi${liveReloadScriptTag}</BODY>`,
	)
	assert.equal(
		injectLiveReloadScript('<p>hi</p>'),
		`<p>hi</p>${liveReloadScriptTag}`,
	)
	const once = injectLiveReloadScript('<p>hi</p>')
	assert.equal(injectLiveReloadScript(once), once)
})

test('shouldInjectLiveReload only touches uncompressed HTML bodies', () => {
	const html = { 'content-type': 'text/html; charset=utf-8' }
	const accept = 'text/html,application/xhtml+xml,*/*;q=0.8'
	assert.equal(
		shouldInjectLiveReload({
			method: 'GET',
			accept,
			status: 200,
			headers: html,
		}),
		true,
	)
	assert.equal(
		shouldInjectLiveReload({
			method: 'GET',
			accept: '*/*',
			status: 200,
			headers: html,
		}),
		false,
	)
	assert.equal(
		shouldInjectLiveReload({
			method: 'HEAD',
			accept,
			status: 200,
			headers: html,
		}),
		false,
	)
	assert.equal(
		shouldInjectLiveReload({
			method: 'GET',
			accept,
			status: 304,
			headers: html,
		}),
		false,
	)
	assert.equal(
		shouldInjectLiveReload({
			method: 'GET',
			accept,
			status: 200,
			headers: { ...html, 'content-encoding': 'gzip' },
		}),
		false,
	)
	assert.equal(
		shouldInjectLiveReload({
			method: 'GET',
			accept,
			status: 200,
			headers: { 'content-type': 'application/json' },
		}),
		false,
	)
})

type SseEvent = { event: string; data: unknown }

function openEventStream(url: string): {
	events: Array<SseEvent>
	close: () => void
} {
	const events: Array<SseEvent> = []
	const req = request(
		url,
		{ headers: { accept: 'text/event-stream' } },
		(res) => {
			let buffer = ''
			res.setEncoding('utf8')
			res.on('data', (chunk: string) => {
				buffer += chunk
				const blocks = buffer.split('\n\n')
				buffer = blocks.pop() ?? ''
				for (const block of blocks) {
					let event = 'message'
					let data = ''
					for (const line of block.split('\n')) {
						if (line.startsWith('event: ')) event = line.slice(7)
						if (line.startsWith('data: ')) data += line.slice(6)
					}
					if (data) events.push({ event, data: JSON.parse(data) })
				}
			})
			res.on('error', () => {})
		},
	)
	req.on('error', () => {})
	req.end()
	return { events, close: () => req.destroy() }
}

test('kody dev injects the live-reload client and pushes reload / build_error over SSE', async () => {
	await withDevServer(async ({ server, writeMessage }) => {
		const page = await server.fetchPath('/', {
			headers: { accept: 'text/html' },
		})
		assert.equal(page.status, 200)
		assert.match(
			page.body,
			/<script type="module" src="\/__kody\/dev\/client\.js"><\/script><\/head>/,
		)
		const agentPage = await server.fetchPath('/')
		assert.doesNotMatch(agentPage.body, /__kody\/dev/)
		assert.equal(
			page.headers['content-length'],
			String(Buffer.byteLength(page.body)),
		)

		const client = await server.fetchPath('/__kody/dev/client.js')
		assert.equal(client.status, 200)
		assert.match(client.headers['content-type'] ?? '', /javascript/)
		assert.match(client.body, /new EventSource/)

		const stream = openEventStream(`${server.url}/__kody/dev/events`)
		try {
			const hello = await waitFor(
				async () => stream.events.find((event) => event.event === 'hello'),
				'hello',
			)
			const firstBuild = (hello.data as { buildId: number }).buildId
			assert.equal(typeof firstBuild, 'number')

			await writeMessage(`export const message = 'live'\n`)
			const reload = await waitFor(
				async () => stream.events.find((event) => event.event === 'reload'),
				'reload event',
			)
			assert.ok((reload.data as { buildId: number }).buildId > firstBuild)

			await writeMessage(`export const message = = 'broken'\n`)
			const buildError = await waitFor(
				async () =>
					stream.events.find((event) => event.event === 'build_error'),
				'build_error event',
			)
			const view = buildError.data as {
				kind: string
				title: string
				detail: string
			}
			assert.equal(view.kind, 'build')
			assert.match(view.detail, /app[\\/]message\.ts:1:24/)

			const errorPage = await server.fetchPath('/', {
				headers: { accept: 'text/html' },
			})
			assert.equal(errorPage.status, 500)
			assert.match(errorPage.body, /__kodyDevErrorPage = true/)
			assert.match(errorPage.body, /\/__kody\/dev\/client\.js/)
		} finally {
			stream.close()
		}
	})
})

test('liveReload: false leaves HTML untouched and serves no dev routes', async () => {
	await withDevServer(
		async ({ server }) => {
			const page = await server.fetchPath('/', {
				headers: { accept: 'text/html' },
			})
			assert.equal(page.status, 200)
			assert.doesNotMatch(page.body, /__kody\/dev/)
		},
		{ liveReload: false },
	)
})
