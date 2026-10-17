type Service = { fetch(request: Request): Promise<Response> }
export type ProbeEnv = {
	START: Service
	LEGACY: Service
	ROUTER: Service
	PROBE_KEY: string
	START_RELEASE: string
	ASSET_PATHS: string
}

/** Temporary remote development probe, never installed as a public route. */
export async function probeRequest(request: Request, env: ProbeEnv) {
	if (
		request.method !== 'GET' ||
		request.headers.get('X-Kody-Probe-Key') !== env.PROBE_KEY ||
		env.PROBE_KEY.length < 32
	)
		return new Response('Forbidden', { status: 403 })
	if (!/^[a-f0-9]{40}$/.test(env.START_RELEASE))
		return new Response('Invalid release', { status: 503 })
	const url = new URL(request.url)
	const prefix = `/__start/${env.START_RELEASE}/`
	let service: Service
	let target: string
	const headers = new Headers({ Accept: 'text/html' })
	switch (url.pathname) {
		case '/start/health':
			service = env.START
			target = '/health'
			break
		case '/legacy/health':
			service = env.LEGACY
			target = '/health'
			break
		case '/router/health':
			service = env.ROUTER
			target = '/health'
			break
		case '/start/document':
			service = env.START
			target = '/'
			break
		case '/legacy/document':
			service = env.LEGACY
			target = '/'
			break
		case '/router/document':
			service = env.ROUTER
			target = '/'
			break
		case '/router/invalid-preference':
			service = env.ROUTER
			target = '/'
			headers.set('Cookie', '__Host-kody_start=invalid-signature')
			break
		case '/router/opt-in':
			service = env.ROUTER
			target = '/__start/opt-in'
			break
		case '/router/rpc':
			service = env.ROUTER
			target = `${prefix}_serverFn/probe-nonexistent`
			break
		case '/router/unknown-asset':
			service = env.ROUTER
			target = `${prefix}not-an-emitted-probe-file.js`
			break
		case '/start/asset':
		case '/router/asset': {
			const asset = url.searchParams.get('path')
			const paths: unknown = JSON.parse(env.ASSET_PATHS)
			if (
				!asset ||
				!Array.isArray(paths) ||
				!paths.includes(asset) ||
				// Reject URL normalization of allowlisted paths.
				// eslint-disable-next-line no-control-regex
				/[%\\?#\x00-\x20\x7f]/.test(asset) ||
				asset.startsWith('/') ||
				asset
					.split('/')
					.some((part) => !part || part === '.' || part === '..') ||
				asset.startsWith('_serverFn/')
			)
				return new Response('Unknown asset', { status: 404 })
			service = url.pathname === '/start/asset' ? env.START : env.ROUTER
			const canonical = asset.split('/').map(encodeURIComponent).join('/')
			target = `${prefix}${url.pathname === '/start/asset' || url.searchParams.get('encoded') === '1' ? canonical : asset}`
			headers.set('Accept', '*/*')
			break
		}
		default:
			return new Response('Unknown probe', { status: 404 })
	}
	if (target === '/health') headers.set('Accept', 'application/json')
	// Neither incoming cookies nor credentials can reach production services.
	const result = await service.fetch(
		new Request(`https://kody.codes${target}`, {
			method: 'GET',
			headers,
			redirect: 'manual',
		}),
	)
	const safeHeaders = new Headers({ 'Cache-Control': 'no-store' })
	if (target === '/health') {
		safeHeaders.set(
			'X-Probe-Commit-Present',
			result.headers.has('X-App-Commit-Sha') ? 'true' : 'false',
		)
		let category = 'none'
		if (result.status >= 500) {
			const body = await result.clone().text()
			category = body.includes('illustrated-error-page')
				? 'native-error-page'
				: /(?:Error|error code)\s*1101\b/.test(body)
					? 'cloudflare-1101'
					: /(?:Error|error code)\s*1102\b/.test(body)
						? 'cloudflare-1102'
						: 'unknown-error'
		}
		safeHeaders.set('X-Probe-Error-Class', category)
	}

	for (const name of ['Content-Type', 'Cache-Control']) {
		const value = result.headers.get(name)
		if (value) safeHeaders.set(`X-Probe-${name}`, value)
	}
	return new Response(result.body, {
		status: result.status,
		headers: safeHeaders,
	})
}
export default { fetch: probeRequest }
