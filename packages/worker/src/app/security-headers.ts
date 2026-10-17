/**
 * First-party HTTP security headers.
 *
 * These are applied to the trusted website responses by Start's server entry.
 * They are intentionally NOT applied to
 * untrusted, dynamically-authored surfaces such as hosted package apps
 * (`/@username/packages/*`), which execute author-supplied HTML/JS and need
 * their own, looser policies.
 *
 * Content-Security-Policy notes:
 * - `script-src 'self'` (no `'unsafe-inline'`) is the important protection: the
 *   client bundle is loaded as an external module from the same origin, so an
 *   injected inline `<script>` cannot execute. Do NOT add `'unsafe-inline'` to
 *   `script-src`. Start document responses add a request-specific nonce for
 *   framework scripts, including native Router scroll restoration. The base
 *   policy has no static inline-script hash allowance.
 * - `style-src` allows `'unsafe-inline'` because SSR streamed styles arrive as
 *   inline `<style>` tags; style injection is far lower risk than script
 *   injection. Client-side styles use constructable stylesheets, which CSP does
 *   not gate.
 * - `frame-ancestors 'none'` (plus `X-Frame-Options: DENY`) stops clickjacking
 *   of the OAuth consent screen and account pages.
 * - `base-uri`, `object-src`, and `form-action` are locked to prevent base-tag
 *   injection, plugin content, and form exfiltration to third-party origins.
 * - `connect-src` stays `'self'` for first-party JSON and the `/sentry-tunnel`
 *   route (see `handlers/sentry-tunnel.ts`). The listed third-party hosts are
 *   the only browser beacons that leave the origin.
 * - `https://cdn.usefathom.com` in `script-src`, `img-src`, and `connect-src`
 *   allows the Fathom Analytics tracker (rendered only when FATHOM_SITE_ID is
 *   set, see `ssr-document.tsx`): the script loads from that host, reports
 *   pageviews via an image beacon, and uses `navigator.sendBeacon` for
 *   visit-duration pings and `trackEvent`.
 * - `https://static.scarf.sh` in `img-src` allows the Scarf page pixel
 *   (`packages/worker/client/scarf-analytics.ts`). It fires only on
 *   `https://kody.codes` public marketing and docs paths, sends the path
 *   without query strings or fragments, and skips Global Privacy Control and
 *   Do Not Track. Scarf is not a script.
 * - Cloudflare Web Analytics: injected at the edge by Cloudflare,
 *   privacy-preserving, no cookies. The beacon script loads from
 *   `https://static.cloudflareinsights.com` (`script-src`) and POSTs to
 *   `https://cloudflareinsights.com` (`connect-src`).
 * - Cloudflare Turnstile loads its explicit-render API and challenge iframe
 *   from `https://challenges.cloudflare.com` when both keys are configured.
 * - `https://www.youtube-nocookie.com` in `frame-src` is the privacy-enhanced
 *   YouTube player used by the site-wide `/?youtubeId=` overlay. Thumbnails stay
 *   first-party via `/youtube-thumb/:videoId`; do not open `img-src` to
 *   `i.ytimg.com`.
 * - `worker-src 'self' blob:` exists for Sentry Session Replay's compression
 *   Web Worker, which is created from a blob URL. Spawning a blob worker
 *   already requires script execution, which `script-src 'self'` still gates,
 *   so this does not widen the injection surface.
 */
const contentSecurityPolicy = [
	"default-src 'self'",
	"base-uri 'self'",
	"object-src 'none'",
	"frame-ancestors 'none'",
	"form-action 'self'",
	"img-src 'self' data: blob: https://cdn.usefathom.com https://static.scarf.sh",
	"font-src 'self' data:",
	"style-src 'self' 'unsafe-inline'",
	`script-src 'self' https://cdn.usefathom.com https://static.cloudflareinsights.com https://challenges.cloudflare.com`,
	"connect-src 'self' https://cdn.usefathom.com https://cloudflareinsights.com https://challenges.cloudflare.com",
	'frame-src https://challenges.cloudflare.com https://www.youtube-nocookie.com',
	"worker-src 'self' blob:",
].join('; ')

export const firstPartySecurityHeaders: Readonly<Record<string, string>> = {
	'Content-Security-Policy': contentSecurityPolicy,
	'X-Frame-Options': 'DENY',
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'strict-origin-when-cross-origin',
	// Ignored by browsers over plain HTTP (local dev), enforced over HTTPS.
	'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
}

export function applyFirstPartySecurityHeaders(response: Response): Response {
	for (const [name, value] of Object.entries(firstPartySecurityHeaders)) {
		response.headers.set(name, value)
	}
	return response
}
