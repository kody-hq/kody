import { AsyncLocalStorage } from 'node:async_hooks'
import {
	applyServerTimingHeader,
	type ServerTimingEntry,
} from '#worker/server-timing.ts'
import {
	type PackageAppAudience,
	appendPackageAppVary,
	privateCacheControl,
} from './package-app-cache-headers.ts'
import {
	enforcePackageAppSetCookieHttpOnly,
	type PackageAppCookieFinding,
} from './package-app-cookie-httponly.ts'
import { isPackageAppOwnCookieName } from './package-app-cookie-prefix.ts'
import {
	packageAppRuntimeErrorHeader,
	packageAppRuntimeRunIdHeader,
} from './package-app-diagnostics.ts'
import {
	packageAppCookieNameFromSetCookie,
	rewritePackageAppSetCookieHeader,
	type StrippedPackageAppSetCookie,
} from './package-app-set-cookie.ts'
import { watchPackageAppVisitBody } from './package-app-visit-ticket.ts'

/**
 * Every header change Kody makes to a package-app response, applied in one
 * pass: one `Set-Cookie` walk, one `Headers` copy, and at most one `Response`.
 *
 * Package cookies (what the app set) are filtered to the package prefix and
 * get `HttpOnly` enforced. Platform cookies (`appendSetCookies`, e.g. the
 * visit ticket) skip both. Every cookie gets the Domain scrub.
 */
export type PackageAppResponseRewrite = {
	/** Domain scrub for every Set-Cookie. */
	domainScrub?: {
		responseHostname: string
		packageAppApexHostnames: ReadonlyArray<string>
	}
	/** Drop package Set-Cookies outside this package's prefix. */
	cookiePrefix?: string
	/** Enforce HttpOnly on package auth cookies. */
	httpOnly?: { clientReadable: ReadonlyArray<string> }
	stripRuntimeRunId?: boolean
	cacheAudience?: PackageAppAudience
	appendSetCookies?: Array<string>
	serverTiming?: Array<ServerTimingEntry>
	/** Burn this visit nonce when the body finishes. */
	visitNonce?: string | null
	onReport?: Array<(report: PackageAppResponseRewriteReport) => void>
}

export type PackageAppResponseRewriteReport = {
	stripped: Array<StrippedPackageAppSetCookie>
	dropped: Array<string>
	findings: Array<PackageAppCookieFinding>
	runtimeRunId: string | null
}

function mergeRewrite(
	base: PackageAppResponseRewrite,
	next: PackageAppResponseRewrite,
): PackageAppResponseRewrite {
	const merged: PackageAppResponseRewrite = { ...base }
	for (const [key, value] of Object.entries(next)) {
		if (value === undefined) continue
		;(merged as Record<string, unknown>)[key] = value
	}
	merged.appendSetCookies = [
		...(base.appendSetCookies ?? []),
		...(next.appendSetCookies ?? []),
	]
	merged.serverTiming =
		base.serverTiming &&
		next.serverTiming &&
		base.serverTiming !== next.serverTiming
			? [...base.serverTiming, ...next.serverTiming]
			: (next.serverTiming ?? base.serverTiming)
	merged.onReport = [...(base.onReport ?? []), ...(next.onReport ?? [])]
	merged.stripRuntimeRunId = base.stripRuntimeRunId || next.stripRuntimeRunId
	merged.visitNonce = next.visitNonce ?? base.visitNonce ?? null
	return merged
}

const nullBodyStatuses = new Set([204, 205, 304])

/**
 * Apply a rewrite now. Status-101 responses without a paired `webSocket`
 * are returned untouched. A WebSocket handshake only gets its cookies
 * rewritten (rebuilt as 200 + the same socket, which Workers turns back into
 * 101); cache headers, run-id strip, and Server-Timing skip it.
 */
export function applyPackageAppResponseRewrite(
	response: Response,
	rewrite: PackageAppResponseRewrite,
): { response: Response; report: PackageAppResponseRewriteReport } {
	const report: PackageAppResponseRewriteReport = {
		stripped: [],
		dropped: [],
		findings: [],
		runtimeRunId: response.headers.get(packageAppRuntimeRunIdHeader),
	}
	const webSocket = response.webSocket ?? null
	const finish = (result: Response) => {
		for (const onReport of rewrite.onReport ?? []) onReport(report)
		return { response: result, report }
	}
	if (response.status === 101 && !webSocket) {
		if (rewrite.visitNonce) {
			watchPackageAppVisitBody(null, rewrite.visitNonce)
		}
		return finish(response)
	}
	let changed = false
	const headers = new Headers(response.headers)

	const packageCookies =
		typeof response.headers.getSetCookie === 'function'
			? response.headers.getSetCookie()
			: []
	const cookies: Array<string> = []
	for (const cookie of packageCookies) {
		if (
			rewrite.cookiePrefix !== undefined &&
			!isPackageAppOwnCookieName(
				packageAppCookieNameFromSetCookie(cookie),
				rewrite.cookiePrefix,
			)
		) {
			report.dropped.push(packageAppCookieNameFromSetCookie(cookie))
			changed = true
			continue
		}
		let next = cookie
		if (rewrite.httpOnly) {
			const enforced = enforcePackageAppSetCookieHttpOnly(next, {
				clientReadable: rewrite.httpOnly.clientReadable,
				now: Date.now(),
			})
			if (enforced.finding && report.findings.length < 20) {
				report.findings.push(enforced.finding)
			}
			if (enforced.header !== next) changed = true
			next = enforced.header
		}
		cookies.push(next)
	}
	const appended = rewrite.appendSetCookies ?? []
	const allowAppend = !webSocket
	if (allowAppend && appended.length > 0) changed = true
	const finalCookies: Array<string> = []
	for (const cookie of allowAppend ? [...cookies, ...appended] : cookies) {
		if (
			rewrite.domainScrub &&
			rewrite.domainScrub.packageAppApexHostnames.length > 0
		) {
			const result = rewritePackageAppSetCookieHeader(
				cookie,
				rewrite.domainScrub,
			)
			if (result.strippedDomain) {
				changed = true
				report.stripped.push({
					cookieName: packageAppCookieNameFromSetCookie(cookie),
					domain: result.strippedDomain,
				})
			}
			finalCookies.push(result.header)
			continue
		}
		finalCookies.push(cookie)
	}
	if (changed) {
		headers.delete('Set-Cookie')
		for (const cookie of finalCookies) {
			if (cookie.length > 0) headers.append('Set-Cookie', cookie)
		}
	}

	if (!webSocket) {
		if (rewrite.stripRuntimeRunId) {
			if (
				headers.has(packageAppRuntimeRunIdHeader) ||
				headers.has(packageAppRuntimeErrorHeader)
			) {
				headers.delete(packageAppRuntimeRunIdHeader)
				headers.delete(packageAppRuntimeErrorHeader)
				changed = true
			}
		}
		if (rewrite.cacheAudience) {
			if (rewrite.cacheAudience === 'signed-in') {
				headers.set(
					'Cache-Control',
					privateCacheControl(headers.get('Cache-Control')),
				)
			}
			appendPackageAppVary(headers, 'Cookie')
			changed = true
		}
		if (rewrite.serverTiming && rewrite.serverTiming.length > 0) {
			applyServerTimingHeader(headers, rewrite.serverTiming)
			changed = true
		}
	}

	const watchBody = Boolean(rewrite.visitNonce) && !webSocket
	if (!webSocket && rewrite.visitNonce && !response.body) {
		watchPackageAppVisitBody(null, rewrite.visitNonce)
	}
	if (webSocket && rewrite.visitNonce) {
		watchPackageAppVisitBody(null, rewrite.visitNonce)
	}
	if (!changed && !(watchBody && response.body)) return finish(response)

	const nullBody = nullBodyStatuses.has(response.status)
	const body =
		nullBody || webSocket
			? null
			: watchBody && response.body
				? watchPackageAppVisitBody(response.body, rewrite.visitNonce ?? null)
				: response.body
	const init: ResponseInit & { webSocket?: WebSocket } = {
		status: webSocket ? 200 : response.status,
		statusText: response.statusText,
		headers,
	}
	if (webSocket) init.webSocket = webSocket
	const rebuilt = new Response(body, init)
	if (webSocket && rebuilt.webSocket !== webSocket) {
		Object.defineProperty(rebuilt, 'webSocket', {
			value: webSocket,
			configurable: true,
		})
	}
	return finish(rebuilt)
}

type RewriteScope = { pending: WeakMap<Response, PackageAppResponseRewrite> }

const rewriteScope = new AsyncLocalStorage<RewriteScope>()

/**
 * Run `serve` with deferred rewrites: layers inside it register their part
 * with {@link deferPackageAppResponseRewrite}, and the response leaves
 * through one {@link applyPackageAppResponseRewrite} with `boundary` merged
 * last.
 */
export async function runWithPackageAppResponseRewrite(
	serve: () => Promise<Response | null>,
	boundary: (input: {
		/** A layer inside the scope registered an `onReport` for this response. */
		reported: boolean
	}) => PackageAppResponseRewrite,
): Promise<Response | null> {
	const scope: RewriteScope = { pending: new WeakMap() }
	const response = await rewriteScope.run(scope, serve)
	if (!response) return null
	const pending = scope.pending.get(response)
	return applyPackageAppResponseRewrite(
		response,
		mergeRewrite(
			pending ?? {},
			boundary({ reported: (pending?.onReport?.length ?? 0) > 0 }),
		),
	).response
}

/**
 * Register part of a package-app response rewrite. Inside
 * {@link runWithPackageAppResponseRewrite} it is merged into the single pass
 * at the boundary and `response` comes back unchanged; anywhere else (RPC
 * serve, inline package-app routes) it is applied now.
 */
export function deferPackageAppResponseRewrite(
	response: Response,
	rewrite: PackageAppResponseRewrite,
): Response {
	const scope = rewriteScope.getStore()
	if (!scope) return applyPackageAppResponseRewrite(response, rewrite).response
	const existing = scope.pending.get(response)
	scope.pending.set(
		response,
		existing ? mergeRewrite(existing, rewrite) : mergeRewrite({}, rewrite),
	)
	return response
}
