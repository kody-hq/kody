import { getDomain } from 'tldts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	BoundedBodyTooLargeError,
	readBoundedBody,
	readBoundedBodyBytes,
} from '#mcp/capabilities/integrations/read-bounded-body.ts'
import { sniffPlatformOauthAppLogoFormat } from './platform-app-logo.ts'
import { getOauthAppBySlug } from './repo.ts'
import { setUserOauthAppLogo } from './user-oauth-app-logo.ts'
import type { UserOauthApp } from './types.ts'

const maxFaviconSourceBytes = 1_000_000
const maxHtmlBytes = 512_000
const fetchTimeoutMs = 8_000
const maxRedirectHops = 5
const maxBackfillPerPage = 5

export function resolveFaviconOrigin(
	urls: Array<string | null | undefined>,
): { origin: URL; host: string } | null {
	for (const raw of urls) {
		if (!raw?.trim()) continue
		try {
			const url = assertHttpsPublicUrl(raw)
			const registrable = getDomain(url.hostname) ?? url.hostname
			if (!registrable) continue
			return {
				origin: new URL(`https://${registrable}/`),
				host: registrable,
			}
		} catch {
			continue
		}
	}
	return null
}

export function assertHttpsPublicUrl(raw: string): URL {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		throw new Error(`Favicon URL is not a valid URL: ${raw}`)
	}
	if (url.protocol !== 'https:') {
		throw new Error(
			`Favicon URL must use https (got ${url.protocol || 'unknown protocol'})`,
		)
	}
	if (url.username || url.password) {
		throw new Error('Favicon URL must not include embedded credentials')
	}
	const host = url.hostname.toLowerCase()
	if (
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		host === '127.0.0.1' ||
		host === '0.0.0.0' ||
		host === '::1' ||
		host.includes(':') ||
		isIpv4Hostname(host) ||
		host.endsWith('.internal') ||
		host.endsWith('.local')
	) {
		throw new Error(`Favicon host is not a public domain: ${host}`)
	}
	return url
}

function isIpv4Hostname(host: string): boolean {
	const parts = host.split('.')
	return (
		parts.length === 4 &&
		parts.every((part) => {
			if (!/^\d{1,3}$/.test(part)) return false
			const value = Number(part)
			return value >= 0 && value <= 255
		})
	)
}

type IconCandidate = {
	href: string
	rel: string
	size: number
}

export function parseHtmlIconCandidates(
	html: string,
	pageUrl: URL,
): Array<IconCandidate> {
	const candidates: Array<IconCandidate> = []
	const tagRe = /<link\b[^>]*>/gi
	for (const match of html.matchAll(tagRe)) {
		const tag = match[0] ?? ''
		const rel = readHtmlAttr(tag, 'rel')?.toLowerCase() ?? ''
		const relTokens = new Set(rel.split(/\s+/).filter(Boolean))
		const isApple = relTokens.has('apple-touch-icon')
		const isIcon = relTokens.has('icon') || relTokens.has('shortcut')
		if (!isApple && !isIcon) continue
		const href = readHtmlAttr(tag, 'href')
		if (!href) continue
		let absolute: URL
		try {
			absolute = new URL(href, pageUrl)
			assertHttpsPublicUrl(absolute.toString())
		} catch {
			continue
		}
		candidates.push({
			href: absolute.toString(),
			rel: isApple ? 'apple-touch-icon' : 'icon',
			size: parseIconSizes(readHtmlAttr(tag, 'sizes')),
		})
	}
	candidates.sort((left, right) => {
		if (left.rel !== right.rel) {
			return left.rel === 'apple-touch-icon' ? -1 : 1
		}
		return right.size - left.size
	})
	return candidates
}

function readHtmlAttr(tag: string, name: string): string | null {
	const quoted = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag)
	if (quoted?.[1]) return quoted[1].trim()
	const bare = new RegExp(`${name}\\s*=\\s*([^\\s>]+)`, 'i').exec(tag)
	return bare?.[1]?.trim() ?? null
}

function parseIconSizes(raw: string | null): number {
	if (!raw) return 0
	let max = 0
	for (const part of raw.split(/\s+/)) {
		const match = /^(\d+)x(\d+)$/i.exec(part)
		if (!match) continue
		max = Math.max(max, Number(match[1]) * Number(match[2]))
	}
	return max
}

function isRedirectStatus(status: number): boolean {
	return status >= 300 && status < 400
}

/**
 * Classic ICO is a BMP container we do not rasterize. Vista+ ICO files
 * often embed a PNG; extract the largest one so `/favicon.ico` still
 * works when that is the only published mark.
 */
export function extractPngFromIco(bytes: Uint8Array): Uint8Array | null {
	if (bytes.byteLength < 6) return null
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) {
		return null
	}
	const count = view.getUint16(4, true)
	if (count === 0 || bytes.byteLength < 6 + count * 16) return null
	let best: Uint8Array | null = null
	for (let index = 0; index < count; index += 1) {
		const entry = 6 + index * 16
		const size = view.getUint32(entry + 8, true)
		const offset = view.getUint32(entry + 12, true)
		if (size < 8 || offset + size > bytes.byteLength) continue
		const image = bytes.subarray(offset, offset + size)
		if (
			image[0] !== 0x89 ||
			image[1] !== 0x50 ||
			image[2] !== 0x4e ||
			image[3] !== 0x47
		) {
			continue
		}
		if (!best || image.byteLength > best.byteLength) best = image
	}
	return best
}

async function fetchHttpsPublic(input: {
	url: string
	accept: string
	maxBytes: number
	as: 'text' | 'bytes'
}): Promise<{ url: URL; text?: string; bytes?: Uint8Array } | null> {
	let url = assertHttpsPublicUrl(input.url)
	let response: Response
	try {
		for (let hop = 0; ; hop += 1) {
			response = await fetch(url.toString(), {
				headers: { Accept: input.accept },
				redirect: 'manual',
				signal: AbortSignal.timeout(fetchTimeoutMs),
			})
			if (!isRedirectStatus(response.status)) break
			void response.body?.cancel().catch(() => {})
			if (hop >= maxRedirectHops) return null
			const location = response.headers.get('location')
			if (!location?.trim()) return null
			url = assertHttpsPublicUrl(new URL(location, url).toString())
		}
	} catch {
		return null
	}
	if (!response.ok) {
		void response.body?.cancel().catch(() => {})
		return null
	}
	try {
		if (input.as === 'text') {
			return { url, text: await readBoundedBody(response, input.maxBytes) }
		}
		return {
			url,
			bytes: await readBoundedBodyBytes(response, input.maxBytes),
		}
	} catch (error) {
		if (error instanceof BoundedBodyTooLargeError) return null
		return null
	}
}

export async function fetchFaviconBytes(input: {
	origin: URL
}): Promise<Uint8Array | null> {
	const page = await fetchHttpsPublic({
		url: input.origin.href,
		accept: 'text/html,application/xhtml+xml,*/*',
		maxBytes: maxHtmlBytes,
		as: 'text',
	})
	const candidates = page?.text
		? parseHtmlIconCandidates(page.text, page.url)
		: []
	const hrefs = [
		...candidates.map((candidate) => candidate.href),
		new URL('/apple-touch-icon.png', input.origin).href,
		new URL('/favicon.png', input.origin).href,
		new URL('/favicon.ico', input.origin).href,
	]
	const seen = new Set<string>()
	for (const href of hrefs) {
		if (seen.has(href)) continue
		seen.add(href)
		const fetched = await fetchHttpsPublic({
			url: href,
			accept: 'image/png,image/webp,image/jpeg,image/svg+xml,image/x-icon,*/*',
			maxBytes: maxFaviconSourceBytes,
			as: 'bytes',
		})
		if (!fetched?.bytes) continue
		const sourceBytes =
			sniffPlatformOauthAppLogoFormat(fetched.bytes) != null
				? fetched.bytes
				: extractPngFromIco(fetched.bytes)
		if (!sourceBytes) continue
		return sourceBytes
	}
	return null
}

export function shouldFetchUserOauthAppFavicon(app: UserOauthApp): boolean {
	if (app.logoSource === 'upload' && app.logoKey) return false
	if (!app.logoSource && app.logoKey) return false
	const resolved = resolveFaviconOrigin([
		app.authorizeUrl,
		app.apiBaseUrl,
		app.tokenUrl,
	])
	if (!resolved) return false
	if (app.logoSource === 'favicon' && app.logoKey) {
		return app.faviconSourceHost !== resolved.host
	}
	return true
}

export async function fillUserOauthAppFavicon(input: {
	db: D1Database
	env: Pick<Env, 'COMMUNITY_ASSETS' | 'IMAGES'>
	userId: string
	slug: string
}): Promise<UserOauthApp | null> {
	const app = await getOauthAppBySlug({
		db: input.db,
		userId: input.userId,
		slug: input.slug,
	})
	if (!app || !shouldFetchUserOauthAppFavicon(app)) return app
	const resolved = resolveFaviconOrigin([
		app.authorizeUrl,
		app.apiBaseUrl,
		app.tokenUrl,
	])
	if (!resolved) return app
	const bytes = await fetchFaviconBytes({
		origin: resolved.origin,
	})
	if (!bytes) return app
	try {
		return await setUserOauthAppLogo({
			db: input.db,
			env: input.env,
			userId: input.userId,
			slug: app.slug,
			sourceBytes: bytes,
			source: 'favicon',
			faviconSourceHost: resolved.host,
		})
	} catch (error) {
		console.error(
			'user-oauth-app-favicon-store-failed',
			app.slug,
			getErrorMessage(error),
		)
		return app
	}
}

export async function scheduleUserOauthAppFaviconFill(input: {
	db: D1Database
	env: Pick<Env, 'APP_DB' | 'COMMUNITY_ASSETS' | 'IMAGES'> | Pick<Env, 'APP_DB'>
	userId: string
	slug: string
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	if (
		!('COMMUNITY_ASSETS' in input.env) ||
		!input.env.COMMUNITY_ASSETS ||
		!('IMAGES' in input.env) ||
		!input.env.IMAGES
	) {
		return
	}
	const env = input.env as Pick<Env, 'APP_DB' | 'COMMUNITY_ASSETS' | 'IMAGES'>
	const work = fillUserOauthAppFavicon({
		db: input.db,
		env,
		userId: input.userId,
		slug: input.slug,
	}).catch((error: unknown) => {
		console.error(
			'user-oauth-app-favicon-fill-failed',
			input.slug,
			getErrorMessage(error),
		)
	})
	if (input.waitUntil) {
		input.waitUntil(work)
		return
	}
	await work
}

export async function backfillMissingUserOauthAppFavicons(input: {
	db: D1Database
	env: Pick<Env, 'APP_DB' | 'COMMUNITY_ASSETS' | 'IMAGES'> | Pick<Env, 'APP_DB'>
	userId: string
	apps: Array<UserOauthApp>
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	if (
		!('COMMUNITY_ASSETS' in input.env) ||
		!input.env.COMMUNITY_ASSETS ||
		!('IMAGES' in input.env) ||
		!input.env.IMAGES
	) {
		return
	}
	const pending = input.apps
		.filter((app) => shouldFetchUserOauthAppFavicon(app))
		.slice(0, maxBackfillPerPage)
	if (pending.length === 0) return
	const env = input.env as Pick<Env, 'APP_DB' | 'COMMUNITY_ASSETS' | 'IMAGES'>
	const work = (async () => {
		for (const app of pending) {
			await fillUserOauthAppFavicon({
				db: input.db,
				env,
				userId: input.userId,
				slug: app.slug,
			}).catch((error: unknown) => {
				console.error(
					'user-oauth-app-favicon-backfill-failed',
					app.slug,
					getErrorMessage(error),
				)
			})
		}
	})()
	if (input.waitUntil) {
		input.waitUntil(work)
		return
	}
	await work
}
