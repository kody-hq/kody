import { type ClientErrorContext } from './sentry-client.ts'
import * as Sentry from '@sentry/browser'
import { reloadOnStaleRouteChunk } from '#client/reload-on-stale-route-chunk.ts'
import { reloadOnUnknownStartRelease } from '#client/reload-on-unknown-start-release.ts'
import { filterBrowserSentryEvent } from '#client/sentry-browser-filters.ts'
import { type SentryClientConfig } from '#universal/sentry-config.ts'

/**
 * Real browser Sentry SDK init. Loaded only via dynamic `import()` from
 * `sentry-client.ts` so `@sentry/*` stays out of the critical-path entry chunk.
 *
 * Privacy defaults match the previous synchronous client: all text masked and
 * all media blocked in replays, error-only Session Replay (no session sample),
 * no PII, envelopes via the same-origin tunnel.
 */
export function initBrowserSentry(config: SentryClientConfig) {
	Sentry.init({
		dsn: config.dsn,
		tunnel: config.tunnel,
		environment: config.environment,
		...(config.release ? { release: config.release } : {}),
		sendDefaultPii: false,
		integrations: [
			Sentry.replayIntegration({
				maskAllText: true,
				blockAllMedia: true,
				// blockAllMedia's MEDIA_SELECTORS omit iframe. Cross-origin
				// embeds (landing/docs YouTube lite player →
				// youtube-nocookie.com, Turnstile challenge frames, etc.)
				// still fire rrweb onIframeLoad → observeAttachShadow, which
				// reads iframeWindow.Element unguarded and throws into the
				// page (getsentry/sentry-javascript#23795 / KODY-8W). Blocking
				// iframes skips that path (needBlock / isBlocked). Fixed
				// upstream in @sentry/replay 11.5.0 via rrweb 2.44.1; stay on
				// 10.x until a deliberate v11 migration.
				block: ['iframe'],
			}),
		],
		// Error-only replays: nothing is recorded to Sentry for normal
		// sessions; the in-memory buffer is uploaded only when an error
		// happens.
		replaysSessionSampleRate: 0,
		replaysOnErrorSampleRate: 1.0,
		// Drop expected browser noise (AbortError aborts, Firefox DOM
		// permission-denied from Replay/hydration on restricted nodes,
		// injected wallet/`__firefox__` globals, Fathom beacon
		// removeChild-on-null, Chrome extension IPC "Object Not Found
		// Matching Id…", Chrome/Firefox extension "Receiving end does not
		// exist", extension "Invalid call to runtime.sendMessage(). Tab not
		// found", MetaMask inpage connect failures, MetaMask plain-object
		// "wallet must has at least one account" rejections, Rabby /
		// Chrome-extension plain-object "Message channel disconnected"
		// rejections (KODY-72 / issue 7715934699), Chrome extension
		// "Client has been destroyed" with exclusively chrome-extension
		// frames, Chrome extension TypeError reading `M_ID` with
		// exclusively chrome-extension frames, Twitter/X in-app browser
		// chrome `CONFIG`
		// ReferenceErrors / `sendScrollEvent`→ `window.webkit.messageHandlers`
		// TypeErrors, injected unguarded `meta[property='og:type']` probes
		// from `global code`, optional Shiki `syntax-highlight-core`
		// dynamic import fetch failures, stale Start release
		// `Unknown Start release.` after deploy (KODY-9E / issue
		// 7795797021), TanStack Start serverFn fetch network TypeErrors
		// (KODY-9Q / issue 7798170337), local Vite / wrangler HMR loopback
		// sessions, and residual Replay onIframeLoad / observeAttachShadow
		// SecurityError|TypeError after cross-origin iframe Element reads
		// (KODY-8W; primary mitigation is block:['iframe'] above))
		// — see filterBrowserSentryEvent /
		// KODY-CLOUDFLARE-23 / KODY-CLOUDFLARE-3Q / KODY-CLOUDFLARE-3S /
		// KODY-CLOUDFLARE-3X / KODY-CLOUDFLARE-43 / KODY-CLOUDFLARE-46 /
		// KODY-CLOUDFLARE-4F / KODY-CLOUDFLARE-5C / KODY-CLOUDFLARE-5K /
		// KODY-CLOUDFLARE-5W / KODY-CLOUDFLARE-5X / KODY-CLOUDFLARE-5Y /
		// KODY-CLOUDFLARE-64 / KODY-6Z / KODY-8W / KODY-72 / KODY-9E /
		// KODY-9Q /
		// issues 7639685398, 7648833360, 7648833403, 7653117289, 7655189301,
		// 7658961865, 7659616372, 7660258027, 7662064169, 7677729361,
		// 7682968915, 7687920474, 7689579030, 7690163947, 7696001937,
		// 7715934699, 7717003182, 7777463624, 7795797021, 7798170337.
		beforeSend(event, hint) {
			const error =
				hint.originalException ??
				event.message ??
				event.exception?.values?.[0]?.value
			// Stale Start release after deploy (KODY-9E): recover with one hard
			// reload even when the SDK (not captureClientException) captured
			// the error — buffer listeners are gone after ensureSentryLoaded.
			// One-shot guard lives in the helper; filter still drops the event.
			reloadOnUnknownStartRelease(error)
			// Stale hashed route chunk (KODY-5W, KODY-9S, KODY-9V, KODY-9Y):
			// drop the event only when this call triggered the one-shot reload.
			// A second failure stays visible. syntax-highlight-core is still
			// dropped by the filter below.
			if (reloadOnStaleRouteChunk(error)) return null
			return filterBrowserSentryEvent(event, hint.originalException)
		},
	})
}

export function captureBrowserException(
	error: unknown,
	context?: ClientErrorContext,
) {
	Sentry.captureException(
		error,
		context?.componentStack ||
			context?.documentMeta ||
			context?.documentHydration
			? {
					extra: {
						componentStack: context.componentStack,
						documentMeta: context.documentMeta,
						documentHydration: context.documentHydration,
					},
				}
			: undefined,
	)
}
