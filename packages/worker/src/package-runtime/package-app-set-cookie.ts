import { isPackageAppOwnCookieName } from './package-app-cookie-prefix.ts'

/**
 * Strip Set-Cookie Domain attributes that would scope a cookie beyond the
 * response host on package-app zones (cookie tossing / session fixation across
 * tenants on a shared registrable domain that is not yet on the Public Suffix
 * List).
 *
 * Host-only cookies (no Domain) are left alone. Domain equal to the exact
 * response hostname is kept only when that host is not itself a package-app
 * apex (apex Domain=apex still covers every subdomain). Sibling and parent
 * Domains under a configured package-app apex are stripped to host-only.
 *
 * Custom hostnames outside package-app apexes are not scrubbed here: a
 * customer Domain on their own eTLD+1 can be legitimate, and browsers already
 * reject Domain values that do not domain-match the response host.
 */

export type StrippedPackageAppSetCookie = {
	cookieName: string
	domain: string
}

export type PackageAppSetCookieScrubResult = {
	response: Response
	stripped: Array<StrippedPackageAppSetCookie>
}

export type DroppedPackageAppSetCookieResult = {
	response: Response
	dropped: Array<string>
}

export function packageAppCookieNameFromSetCookie(header: string): string {
	const pair = header.split(';', 1)[0] ?? ''
	const name = pair.split('=', 1)[0]?.trim() ?? ''
	return name.length > 0 ? name : '(unknown)'
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

export function filterPackageAppSetCookies(
	response: Response,
	prefix: string,
): DroppedPackageAppSetCookieResult {
	if (response.status === 101 && !response.webSocket) {
		return { response, dropped: [] }
	}
	const setCookies =
		typeof response.headers.getSetCookie === 'function'
			? response.headers.getSetCookie()
			: []
	if (setCookies.length === 0) return { response, dropped: [] }
	const dropped: Array<string> = []
	const kept: Array<string> = []
	for (const cookie of setCookies) {
		const cookieName = packageAppCookieNameFromSetCookie(cookie)
		if (isPackageAppOwnCookieName(cookieName, prefix)) {
			kept.push(cookie)
		} else {
			dropped.push(cookieName)
		}
	}
	if (dropped.length === 0) return { response, dropped }
	return { response: responseWithSetCookies(response, kept), dropped }
}

export function logPackageAppSetCookieNamesDropped(input: {
	hostname: string
	pathname?: string
	dropped: ReadonlyArray<string>
	surface?: string
}) {
	if (input.dropped.length === 0) return
	console.warn('package-app-set-cookie-name-dropped', {
		hostname: input.hostname,
		pathname: input.pathname,
		surface: input.surface ?? 'host',
		dropped: [...input.dropped],
	})
}

export function normalizeSetCookieDomain(raw: string): string {
	return raw.trim().toLowerCase().replace(/^\./, '').replace(/\.+$/, '')
}

export function normalizeResponseHostname(hostname: string): string {
	return hostname.trim().toLowerCase().replace(/\.+$/, '')
}

/**
 * True when a Set-Cookie Domain would cover the package-app apex or another
 * host under that apex (not only the response host).
 */
export function shouldStripPackageAppSetCookieDomain(input: {
	cookieDomain: string
	responseHostname: string
	packageAppApexHostnames: ReadonlyArray<string>
}): boolean {
	const domain = normalizeSetCookieDomain(input.cookieDomain)
	const host = normalizeResponseHostname(input.responseHostname)
	if (!domain || !host) return false
	for (const apexRaw of input.packageAppApexHostnames) {
		const apex = normalizeResponseHostname(apexRaw)
		if (!apex) continue
		// Apex-wide Domain always covers every tenant subdomain.
		if (domain === apex) return true
		// Sibling or other label under the same apex (not this host).
		if (domain.endsWith(`.${apex}`) && domain !== host) return true
		// A parent of the apex also covers the apex and its tenants (for a
		// nested package-app base such as apps.example.dev under example.dev).
		if (
			apex.endsWith(`.${domain}`) &&
			(host === apex || host.endsWith(`.${apex}`))
		) {
			return true
		}
	}
	return false
}

/**
 * Remove Domain attributes that fail {@link shouldStripPackageAppSetCookieDomain}.
 * Returns the rewritten header and the stripped domain when one was removed.
 */
export function rewritePackageAppSetCookieHeader(
	header: string,
	input: {
		responseHostname: string
		packageAppApexHostnames: ReadonlyArray<string>
	},
): { header: string; strippedDomain: string | null } {
	const parts = header.split(';')
	if (parts.length === 0) return { header, strippedDomain: null }
	const kept: Array<string> = []
	let strippedDomain: string | null = null
	for (const [index, part] of parts.entries()) {
		const trimmed = part.trim()
		// Segment 0 is name=value, never a Domain attribute (a cookie named
		// "domain" must not be treated as Domain=).
		const match = index === 0 ? null : /^domain\s*=\s*(.*)$/i.exec(trimmed)
		if (!match) {
			kept.push(part)
			continue
		}
		const rawDomain = (match[1] ?? '').trim().replace(/^"(.*)"$/, '$1')
		if (
			shouldStripPackageAppSetCookieDomain({
				cookieDomain: rawDomain,
				responseHostname: input.responseHostname,
				packageAppApexHostnames: input.packageAppApexHostnames,
			})
		) {
			strippedDomain = normalizeSetCookieDomain(rawDomain)
			continue
		}
		kept.push(part)
	}
	if (!strippedDomain) return { header, strippedDomain: null }
	return {
		header: kept
			.map((part, index) => (index === 0 ? part.trim() : part))
			.join(';')
			.replace(/;\s*;/g, ';')
			.replace(/;\s*$/, '')
			.trim(),
		strippedDomain,
	}
}

/**
 * Scrub unsafe Domain attributes on every Set-Cookie of a response.
 *
 * Status-101 responses without a paired `webSocket` are left untouched (cannot
 * be rebuilt). Handshake responses that carry `webSocket` are rebuilt with
 * status 200 plus the same socket (Workers converts that back to 101) so
 * Domain can still be stripped.
 */
export function scrubPackageAppSetCookieDomains(
	response: Response,
	input: {
		responseHostname: string
		packageAppApexHostnames: ReadonlyArray<string>
	},
): PackageAppSetCookieScrubResult {
	if (response.status === 101 && !response.webSocket) {
		return { response, stripped: [] }
	}
	if (input.packageAppApexHostnames.length === 0) {
		return { response, stripped: [] }
	}
	const setCookies =
		typeof response.headers.getSetCookie === 'function'
			? response.headers.getSetCookie()
			: []
	if (setCookies.length === 0) return { response, stripped: [] }

	const stripped: Array<StrippedPackageAppSetCookie> = []
	const rewritten: Array<string> = []
	let changed = false
	for (const cookie of setCookies) {
		const result = rewritePackageAppSetCookieHeader(cookie, input)
		rewritten.push(result.header)
		if (result.strippedDomain) {
			changed = true
			stripped.push({
				cookieName: packageAppCookieNameFromSetCookie(cookie),
				domain: result.strippedDomain,
			})
		}
	}
	if (!changed) return { response, stripped: [] }

	const headers = new Headers(response.headers)
	headers.delete('Set-Cookie')
	for (const cookie of rewritten) {
		if (cookie.length === 0) continue
		headers.append('Set-Cookie', cookie)
	}
	// 204, 205, and 304 cannot carry a body. Drop it before rewrapping so a
	// Domain strip on a no-content or not-modified reply cannot throw.
	const nullBody =
		response.status === 204 ||
		response.status === 205 ||
		response.status === 304
	// Workers reject `new Response(..., { status: 101 })`; status 200 with the
	// paired webSocket is converted back to a handshake response. Node's
	// Response ignores `webSocket` in init, so reattach when missing.
	const init: ResponseInit & { webSocket?: WebSocket } = {
		status: response.webSocket ? 200 : response.status,
		statusText: response.statusText,
		headers,
	}
	if (response.webSocket) {
		init.webSocket = response.webSocket
	}
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
	return {
		stripped,
		response: rebuilt,
	}
}

export function logPackageAppSetCookieDomainStripped(input: {
	hostname: string
	pathname?: string
	stripped: ReadonlyArray<StrippedPackageAppSetCookie>
	surface?: string
}) {
	if (input.stripped.length === 0) return
	console.warn('package-app-set-cookie-domain-stripped', {
		hostname: input.hostname,
		pathname: input.pathname,
		surface: input.surface ?? 'host',
		stripped: input.stripped.map((entry) => ({
			cookieName: entry.cookieName,
			domain: entry.domain,
		})),
	})
}

/**
 * Source embedded in the package-app Dynamic Worker so author Set-Cookie Domain
 * strips land in Activity run logs via console.warn capture.
 */
export function createPackageAppSetCookieScrubHostSource(input: {
	packageAppApexHostnames: ReadonlyArray<string>
	cookiePrefix?: string
}): string {
	const apexJson = JSON.stringify(
		input.packageAppApexHostnames.map((hostname) =>
			normalizeResponseHostname(hostname),
		),
	)
	const cookiePrefixJson = JSON.stringify(input.cookiePrefix ?? '')
	return `
const __kodyPackageAppCookieApexes = ${apexJson};
const __kodyPackageAppCookiePrefix = ${cookiePrefixJson};

function __kodyIsPackageAppOwnCookieName(name) {
	return name.startsWith(__kodyPackageAppCookiePrefix) ||
		name.startsWith('__Host-' + __kodyPackageAppCookiePrefix) ||
		name.startsWith('__Secure-' + __kodyPackageAppCookiePrefix);
}

function __kodyNormalizeSetCookieDomain(raw) {
	return String(raw ?? '').trim().toLowerCase().replace(/^\\./, '').replace(/\\.+$/, '');
}

function __kodyShouldStripPackageAppSetCookieDomain(cookieDomain, responseHostname) {
	const domain = __kodyNormalizeSetCookieDomain(cookieDomain);
	const host = String(responseHostname ?? '').trim().toLowerCase().replace(/\\.+$/, '');
	if (!domain || !host) return false;
	for (const apex of __kodyPackageAppCookieApexes) {
		if (!apex) continue;
		if (domain === apex) return true;
		if (domain.endsWith('.' + apex) && domain !== host) return true;
		if (
			apex.endsWith('.' + domain) &&
			(host === apex || host.endsWith('.' + apex))
		) {
			return true;
		}
	}
	return false;
}

function __kodyRewritePackageAppSetCookie(header, responseHostname) {
	const parts = String(header ?? '').split(';');
	const kept = [];
	let strippedDomain = null;
	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index];
		const trimmed = part.trim();
		const match =
			index === 0 ? null : /^domain\\s*=\\s*(.*)$/i.exec(trimmed);
		if (!match) {
			kept.push(part);
			continue;
		}
		const rawDomain = String(match[1] ?? '').trim().replace(/^"(.*)"$/, '$1');
		if (__kodyShouldStripPackageAppSetCookieDomain(rawDomain, responseHostname)) {
			strippedDomain = __kodyNormalizeSetCookieDomain(rawDomain);
			continue;
		}
		kept.push(part);
	}
	if (!strippedDomain) return { header, strippedDomain: null };
	return {
		header: kept
			.map((part, index) => (index === 0 ? part.trim() : part))
			.join(';')
			.replace(/;\\s*;/g, ';')
			.replace(/;\\s*$/, '')
			.trim(),
		strippedDomain,
	};
}

function __kodyScrubPackageAppSetCookieDomains(response, responseHostname) {
	if (!response) return { response, stripped: [], dropped: [] };
	if (response.status === 101 && !response.webSocket) {
		return { response, stripped: [], dropped: [] };
	}
	if (
		!__kodyPackageAppCookieApexes.length &&
		!__kodyPackageAppCookiePrefix
	) {
		return { response, stripped: [], dropped: [] };
	}
	const getSetCookie = response.headers?.getSetCookie;
	const setCookies = typeof getSetCookie === 'function' ? getSetCookie.call(response.headers) : [];
	if (!setCookies.length) return { response, stripped: [], dropped: [] };
	const stripped = [];
	const rewritten = [];
	const dropped = [];
	let changed = false;
	for (const cookie of setCookies) {
		const pair = String(cookie).split(';', 1)[0] ?? '';
		const cookieName = (pair.split('=', 1)[0] ?? '').trim() || '(unknown)';
		if (!__kodyIsPackageAppOwnCookieName(cookieName)) {
			changed = true;
			dropped.push(cookieName);
			continue;
		}
		const result = __kodyRewritePackageAppSetCookie(cookie, responseHostname);
		rewritten.push(result.header);
		if (result.strippedDomain) {
			changed = true;
			stripped.push({ cookieName, domain: result.strippedDomain });
		}
	}
	if (!changed) return { response, stripped: [], dropped: [] };
	const headers = new Headers(response.headers);
	headers.delete('Set-Cookie');
	for (const cookie of rewritten) {
		if (!cookie) continue;
		headers.append('Set-Cookie', cookie);
	}
	const nullBody =
		response.status === 204 ||
		response.status === 205 ||
		response.status === 304;
	const init = {
		status: response.webSocket ? 200 : response.status,
		statusText: response.statusText,
		headers,
	};
	if (response.webSocket) init.webSocket = response.webSocket;
	const rebuilt = new Response(
		nullBody || response.webSocket ? null : response.body,
		init,
	);
	if (response.webSocket && rebuilt.webSocket !== response.webSocket) {
		Object.defineProperty(rebuilt, 'webSocket', {
			value: response.webSocket,
			configurable: true,
		});
	}
	return {
		stripped,
		dropped,
		response: rebuilt,
	};
}
`
}
