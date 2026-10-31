export type PackageAppCookieFinding = {
	cookieName: string
	reason: 'added_httponly' | 'missing_httponly'
}

export type PackageAppCookieWarningView = {
	cookieName: string
	reason: 'added_httponly' | 'missing_httponly'
	lastSeenAt: string
}

const authCookieSegments = new Set([
	'session',
	'sess',
	'sid',
	'auth',
	'token',
	'jwt',
	'login',
	'remember',
	'refresh',
	'access',
	'idtoken',
])

function cookieNameSegments(cookieName: string) {
	return cookieName
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.toLowerCase()
		.split(/[_\-.: ]+/)
		.filter(Boolean)
}

/**
 * The single identification rule for package-app authentication cookies.
 */
export function isPackageAppAuthCookie(input: {
	cookieName: string
	clientReadable?: ReadonlyArray<string>
}): boolean {
	const fullCookieName = input.cookieName
	const cookieName = input.cookieName.replace(
		/^(?:__Host-|__Secure-)?__kapp_[0-9a-f]{12}_/,
		'',
	)
	if (
		input.clientReadable?.includes(cookieName) ||
		input.clientReadable?.includes(fullCookieName)
	) {
		return false
	}
	const segments = cookieNameSegments(cookieName)
	if (segments.some((segment) => segment === 'csrf' || segment === 'xsrf')) {
		return false
	}
	const normalized = cookieName
		.replace(/^__(?:host|secure)-/i, '')
		.toLowerCase()
	if (
		[
			'connect.sid',
			'phpsessid',
			'jsessionid',
			'asp.net_sessionid',
			'__session',
			'laravel_session',
			'_session_id',
		].includes(normalized) ||
		normalized.startsWith('next-auth.') ||
		normalized.startsWith('__secure-next-auth.') ||
		normalized.startsWith('authjs.') ||
		/^sb-.*-auth-token.*$/.test(normalized)
	) {
		return true
	}
	return segments.some(
		(segment, index) =>
			authCookieSegments.has(segment) ||
			(segment === 'id' && segments[index + 1] === 'token'),
	)
}

function packageAppCookieName(header: string) {
	const pair = header.split(';', 1)[0] ?? ''
	const equalsIndex = pair.indexOf('=')
	if (equalsIndex <= 0) return '(unknown)'
	return pair.slice(0, equalsIndex).trim() || '(unknown)'
}

function hasHttpOnlyAttribute(header: string) {
	return header
		.split(';')
		.slice(1)
		.some((attribute) => /^\s*httponly\s*$/i.test(attribute))
}

function isDeletionCookie(header: string, now: number) {
	for (const attribute of header.split(';').slice(1)) {
		const maxAge = /^\s*max-age\s*=\s*(-?\d+)\s*$/i.exec(attribute)
		if (maxAge && Number(maxAge[1]) <= 0) return true
		const expires = /^\s*expires\s*=\s*(.*?)\s*$/i.exec(attribute)
		if (expires) {
			const expiresAt = Date.parse(expires[1] ?? '')
			if (Number.isFinite(expiresAt) && expiresAt < now) return true
		}
	}
	return false
}

function responseWithSetCookies(
	response: Response,
	setCookies: ReadonlyArray<string>,
) {
	const headers = new Headers(response.headers)
	headers.delete('Set-Cookie')
	for (const cookie of setCookies) {
		if (cookie.length > 0) headers.append('Set-Cookie', cookie)
	}
	const nullBody =
		response.status === 204 ||
		response.status === 205 ||
		response.status === 304
	const init: ResponseInit & { webSocket?: WebSocket } = {
		status: response.webSocket ? 200 : response.status,
		statusText: response.statusText,
		headers,
	}
	if (response.webSocket) init.webSocket = response.webSocket
	const rebuilt = new Response(
		nullBody || response.webSocket ? null : response.body,
		init,
	)
	if (response.webSocket && rebuilt.webSocket !== response.webSocket) {
		Object.defineProperty(rebuilt, 'webSocket', {
			value: response.webSocket,
			configurable: true,
		})
	}
	return rebuilt
}

/**
 * One Set-Cookie through the HttpOnly rule: auth cookies gain `HttpOnly`
 * (`added_httponly`), other non-HttpOnly cookies are reported
 * (`missing_httponly`). Deletion cookies are never reported.
 */
export function enforcePackageAppSetCookieHttpOnly(
	cookie: string,
	options: { clientReadable?: ReadonlyArray<string>; now: number },
): { header: string; finding: PackageAppCookieFinding | null } {
	if (hasHttpOnlyAttribute(cookie)) return { header: cookie, finding: null }
	const cookieName = packageAppCookieName(cookie)
	const isAuthCookie = isPackageAppAuthCookie({
		cookieName,
		clientReadable: options.clientReadable,
	})
	const report = !isDeletionCookie(cookie, options.now)
	const finding = (reason: PackageAppCookieFinding['reason']) =>
		report ? { cookieName: cookieName.slice(0, 128), reason } : null
	if (isAuthCookie) {
		return {
			header: `${cookie}; HttpOnly`,
			finding: finding('added_httponly'),
		}
	}
	return { header: cookie, finding: finding('missing_httponly') }
}

export function enforcePackageAppCookieHttpOnly(
	response: Response,
	options: { clientReadable?: ReadonlyArray<string> } = {},
): {
	response: Response
	findings: Array<PackageAppCookieFinding>
} {
	if (response.status === 101 && !response.webSocket) {
		return { response, findings: [] }
	}
	const setCookies =
		typeof response.headers.getSetCookie === 'function'
			? response.headers.getSetCookie()
			: []
	if (setCookies.length === 0) return { response, findings: [] }

	const now = Date.now()
	const findings: Array<PackageAppCookieFinding> = []
	const rewritten: Array<string> = []
	let changed = false
	for (const cookie of setCookies) {
		const enforced = enforcePackageAppSetCookieHttpOnly(cookie, {
			clientReadable: options.clientReadable,
			now,
		})
		rewritten.push(enforced.header)
		if (enforced.header !== cookie) changed = true
		if (enforced.finding && findings.length < 20) {
			findings.push(enforced.finding)
		}
	}
	return {
		response: changed ? responseWithSetCookies(response, rewritten) : response,
		findings,
	}
}

const packageAppCookieFindingWrites = new Map<string, number>()
const findingThrottleMs = 60 * 60 * 1000

export function resetPackageAppCookieFindingWritesForTests() {
	packageAppCookieFindingWrites.clear()
}

export async function recordPackageAppCookieFindings(input: {
	db: D1Database
	packageId: string
	findings: ReadonlyArray<PackageAppCookieFinding>
	hostname: string
	pathname: string
	now: number
}) {
	const now = input.now
	const nowIso = new Date(now).toISOString()
	const pending = new Map<
		string,
		{ cookieName: string; reason: PackageAppCookieFinding['reason'] }
	>()
	for (const finding of input.findings.slice(0, 20)) {
		const cookieName =
			finding.cookieName.split('=', 1)[0]?.slice(0, 128) || '(unknown)'
		const key = `${input.packageId}\0${cookieName}\0${finding.reason}`
		if (pending.has(key)) continue
		const lastWrite = packageAppCookieFindingWrites.get(key)
		if (lastWrite !== undefined && now - lastWrite < findingThrottleMs) {
			continue
		}
		pending.set(key, { cookieName, reason: finding.reason })
	}
	if (pending.size === 0) return

	console.warn('package-app-cookie-httponly', {
		hostname: input.hostname,
		pathname: input.pathname,
		packageId: input.packageId,
		findings: Array.from(pending.values()),
	})

	for (const [key, finding] of pending) {
		packageAppCookieFindingWrites.set(key, now)
		if (packageAppCookieFindingWrites.size > 2000) {
			packageAppCookieFindingWrites.clear()
		}
		try {
			await input.db
				.prepare(
					`INSERT INTO package_app_cookie_warnings (
						package_id, owner_user_id, cookie_name, reason, first_seen_at, last_seen_at
					)
					SELECT id, user_id, ?1, ?2, ?3, ?3
					FROM saved_packages
					WHERE id = ?4
					ON CONFLICT (package_id, cookie_name) DO UPDATE SET
						owner_user_id = excluded.owner_user_id,
						reason = excluded.reason,
						last_seen_at = excluded.last_seen_at`,
				)
				.bind(finding.cookieName, finding.reason, nowIso, input.packageId)
				.run()
		} catch (error) {
			if (packageAppCookieFindingWrites.get(key) === now) {
				packageAppCookieFindingWrites.delete(key)
			}
			throw error
		}
	}
}

export async function listPackageAppCookieWarnings(input: {
	db: D1Database
	packageId: string
	now?: number
}): Promise<Array<PackageAppCookieWarningView>> {
	const since = new Date(
		(input.now ?? Date.now()) - 14 * 24 * 60 * 60 * 1000,
	).toISOString()
	const result = await input.db
		.prepare(
			`SELECT cookie_name AS cookieName, reason, last_seen_at AS lastSeenAt
			 FROM package_app_cookie_warnings
			 WHERE package_id = ?1 AND last_seen_at >= ?2
			 ORDER BY last_seen_at DESC
			 LIMIT 50`,
		)
		.bind(input.packageId, since)
		.all<PackageAppCookieWarningView>()
	return result.results ?? []
}
