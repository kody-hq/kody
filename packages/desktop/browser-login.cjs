const http = require('node:http')
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto')
const { renderCallbackPage } = require('./callback-page.cjs')
const secret = () => randomBytes(32).toString('base64url')

function sendPage(response, kind, done) {
	const page = renderCallbackPage(kind)
	if (done) response.once('close', done)
	response.writeHead(page.status, page.headers).end(page.html)
}

// The verifier stays in the main process. Intercepting the loopback code alone
// cannot create a session. Each attempt owns its listener and deadline.
function browserLogin({ origin, mode, openExternal, exchange }) {
	const state = secret()
	const verifier = secret()
	const challenge = createHash('sha256').update(verifier).digest('base64url')
	const controller = new AbortController()
	let finish
	let timer
	let settled = false
	let redeeming = false
	const result = new Promise((resolve, reject) => {
		finish = (error, value) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			controller.abort()
			server.close()
			server.closeAllConnections()
			if (error) reject(error)
			else resolve(value)
		}
	})
	const server = http.createServer(async (request, response) => {
		response.setHeader('Cache-Control', 'no-store')
		response.setHeader('Referrer-Policy', 'no-referrer')
		let url
		try {
			url = new URL(request.url, 'http://127.0.0.1')
		} catch {
			sendPage(response, 'invalid')
			return
		}
		const receivedState = url.searchParams.get('state') || ''
		if (
			request.method !== 'GET' ||
			request.headers.host !== `127.0.0.1:${server.address()?.port}` ||
			url.pathname !== '/kody/desktop/callback' ||
			Buffer.byteLength(receivedState) !== Buffer.byteLength(state) ||
			!timingSafeEqual(Buffer.from(receivedState), Buffer.from(state))
		) {
			sendPage(response, 'invalid')
			return
		}
		if (settled || redeeming) {
			sendPage(response, 'busy')
			return
		}
		// A browser-side refusal (OAuth-style `error`) ends this attempt early.
		if (url.searchParams.has('error')) {
			const denied = url.searchParams.get('error') === 'access_denied'
			redeeming = true
			server.close()
			sendPage(response, denied ? 'denied' : 'failed', () =>
				finish(
					new Error(
						denied
							? 'Browser sign-in was canceled. Please try again.'
							: 'Could not complete browser sign-in. Please try again.',
					),
				),
			)
			return
		}
		if (!/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code') || '')) {
			sendPage(response, 'invalid')
			return
		}
		// Stop accepting callbacks before redeeming, including duplicate requests.
		redeeming = true
		server.close()
		try {
			const value = await exchange({
				code: url.searchParams.get('code'),
				verifier,
				signal: controller.signal,
			})
			sendPage(response, 'success', () => finish(null, value))
		} catch {
			sendPage(response, 'failed', () =>
				finish(
					new Error('Could not complete browser sign-in. Please try again.'),
				),
			)
		}
	})
	server.on('error', () =>
		finish(new Error('Could not start browser sign-in. Please try again.')),
	)
	server.listen(0, '127.0.0.1', async () => {
		if (settled) {
			server.close()
			return
		}
		const url = new URL('/desktop/login', origin)
		url.search = new URLSearchParams({
			callback: `http://127.0.0.1:${server.address().port}/kody/desktop/callback`,
			challenge,
			state,
			mode,
		}).toString()
		timer = setTimeout(
			() => finish(new Error('Browser sign-in timed out. Please try again.')),
			5 * 60_000,
		)
		try {
			await openExternal(url.href)
		} catch {
			finish(new Error('Could not open your browser.'))
		}
	})
	return {
		result,
		cancel: () => finish(new Error('Browser sign-in canceled.')),
	}
}
module.exports = { browserLogin }
