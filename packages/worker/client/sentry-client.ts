import { reloadOnStaleRouteChunk } from '#client/reload-on-stale-route-chunk.ts'
import { reloadOnUnknownStartRelease } from '#client/reload-on-unknown-start-release.ts'
import {
	isBrowserAbortError,
	isBrowserInjectedGlobalNoiseError,
	isChromeExtensionMessageChannelDisconnectedError,
	isCloudflareTurnstileClientError,
	isFirefoxDomPermissionDeniedError,
	isMetaMaskWalletNoAccountError,
	isLocalViteDevError,
	isSyntaxHighlightCoreDynamicImportFailureError,
	isTanStackServerFnFetchNetworkError,
	isUnknownStartReleaseError,
} from '#client/sentry-browser-filters.ts'
import {
	parseSentryClientConfig,
	SENTRY_CONFIG_META_NAME,
	type SentryClientConfig,
} from '#universal/sentry-config.ts'

/**
 * Browser-side Sentry bootstrap: schedules a lazy load of `@sentry/browser`
 * (error capture plus error-only Session Replay) so the SDK stays out of the
 * critical-path entry chunk. Keep this on marketing pages too — unused-JS
 * PSI noise is worth the error/replay coverage.
 *
 * Privacy defaults are strict on purpose — Kody sessions contain personal
 * assistant content (chats, email, secrets pages), so all text is masked and
 * all media blocked in replays, no session-based recording happens (only the
 * ~60s buffer around an error is uploaded), and no PII is attached. Envelopes
 * go through the same-origin `/sentry-tunnel` route, so the first-party CSP
 * (`connect-src 'self'`) stays unchanged.
 *
 * Until the SDK chunk loads, window `error` / `unhandledrejection` and
 * `captureClientException` are buffered (capped) and flushed after init.
 * No-ops when the config meta tag is absent (local dev / tests without a
 * DSN). Must never break app boot.
 */

const BUFFER_CAP = 20
/** Max delay before loading Sentry when the page is idle (requestIdleCallback timeout / setTimeout fallback). */
const IDLE_LOAD_TIMEOUT_MS = 2500
/** Chunk-load attempts before giving up on error reporting for this page. */
const MAX_LOAD_ATTEMPTS = 3

export type ClientErrorContext = {
	componentStack?: string | null
	documentMeta?: Array<{
		name: string
		count: number
		index: number
		differingAttributes: string
	}>
	documentHydration?: {
		bodyEmotionStyleCount: number
		headEmotionStyleCount: number
		bodyEmotionUnmarkedCount: number
		pathname: string | null
	}
}

type CaptureFn = (error: unknown, context?: ClientErrorContext) => void

let pendingConfig: SentryClientConfig | null = null
let captureImpl: CaptureFn | null = null
let errorBuffer: Array<{ error: unknown; context?: ClientErrorContext }> = []
let buffering = false
let loadPromise: Promise<void> | null = null
let loadAttempts = 0
let onWindowError: ((event: ErrorEvent) => void) | null = null
let onUnhandledRejection: ((event: PromiseRejectionEvent) => void) | null = null

function shouldIgnoreBufferedError(error: unknown) {
	return (
		isBrowserAbortError(error) ||
		isFirefoxDomPermissionDeniedError(error) ||
		isBrowserInjectedGlobalNoiseError(error) ||
		isMetaMaskWalletNoAccountError(error) ||
		isChromeExtensionMessageChannelDisconnectedError(error) ||
		isUnknownStartReleaseError(error) ||
		isTanStackServerFnFetchNetworkError(error) ||
		isSyntaxHighlightCoreDynamicImportFailureError(error) ||
		isLocalViteDevError(error) ||
		isCloudflareTurnstileClientError(error)
	)
}

function enqueueBufferedError(error: unknown, context?: ClientErrorContext) {
	if (!buffering || captureImpl) return
	reloadOnUnknownStartRelease(error)
	// First stale-chunk miss reloads and is expected. A later miss (flag
	// already set) falls through so a genuinely missing chunk is reported.
	if (reloadOnStaleRouteChunk(error)) return
	if (shouldIgnoreBufferedError(error)) return
	// Keep the earliest errors when full — the first failure is usually the
	// most diagnostic one.
	if (errorBuffer.length < BUFFER_CAP) {
		errorBuffer.push({ error, context })
	}
	// First (and any subsequent) buffered error loads Sentry immediately so
	// early crashes are not stuck waiting for idle.
	void ensureSentryLoaded()
}

function installBufferListeners() {
	if (typeof window === 'undefined' || buffering) return
	buffering = true
	onWindowError = (event) => {
		enqueueBufferedError(event.error ?? event.message)
	}
	onUnhandledRejection = (event) => {
		enqueueBufferedError(event.reason)
	}
	window.addEventListener('error', onWindowError)
	window.addEventListener('unhandledrejection', onUnhandledRejection)
}

function removeBufferListeners() {
	buffering = false
	if (typeof window === 'undefined') return
	if (onWindowError) {
		window.removeEventListener('error', onWindowError)
		onWindowError = null
	}
	if (onUnhandledRejection) {
		window.removeEventListener('unhandledrejection', onUnhandledRejection)
		onUnhandledRejection = null
	}
}

function scheduleIdleLoad() {
	const startLoad = () => {
		void ensureSentryLoaded()
	}
	if (typeof requestIdleCallback === 'function') {
		requestIdleCallback(startLoad, { timeout: IDLE_LOAD_TIMEOUT_MS })
		return
	}
	setTimeout(startLoad, IDLE_LOAD_TIMEOUT_MS)
}

function ensureSentryLoaded() {
	if (loadPromise) return loadPromise
	const config = pendingConfig
	if (!config) {
		return Promise.resolve()
	}
	if (loadAttempts >= MAX_LOAD_ATTEMPTS) {
		return Promise.resolve()
	}
	loadAttempts += 1
	loadPromise = (async () => {
		try {
			// Dynamic import is intentional: keeps `@sentry/*` in a separate
			// async chunk (repo lint discourages inline imports otherwise).
			const { captureBrowserException, initBrowserSentry } =
				await import('./sentry-init.ts')
			initBrowserSentry(config)
			// Stop buffering before flush so Sentry's own global handlers do
			// not also land in the buffer (avoids double-reporting).
			removeBufferListeners()
			const pending = errorBuffer
			errorBuffer = []
			captureImpl = captureBrowserException
			for (const { error, context } of pending) {
				try {
					captureBrowserException(error, context)
				} catch {
					// Reporting must never break the app.
				}
			}
		} catch (error) {
			console.warn('sentry-client-init-failed', error)
			// Keep the buffer and listeners so a later error can retry the
			// chunk load (a transient network failure must not permanently
			// disable error reporting for the page).
			loadPromise = null
			if (loadAttempts >= MAX_LOAD_ATTEMPTS) {
				removeBufferListeners()
				errorBuffer = []
			}
		}
	})()
	return loadPromise
}

export function initSentryClient(doc: Document): boolean {
	try {
		const content = doc
			.querySelector(`meta[name="${SENTRY_CONFIG_META_NAME}"]`)
			?.getAttribute('content')
		const config = parseSentryClientConfig(content)
		if (!config) return false

		pendingConfig = config
		installBufferListeners()
		scheduleIdleLoad()
		return true
	} catch (error) {
		console.warn('sentry-client-init-failed', error)
		return false
	}
}

/** Report a caught client error without letting reporting itself throw. */
export function captureClientException(
	error: unknown,
	context?: ClientErrorContext,
) {
	// Stale Start release after deploy (KODY-9E): recover with one hard reload
	// before dropping the event from Sentry (handled createServerFn path).
	reloadOnUnknownStartRelease(error)
	// Stale hashed route chunk (KODY-5W, KODY-9S, KODY-9V, KODY-9Y): skip
	// Sentry only when this call triggered the one-shot reload.
	if (reloadOnStaleRouteChunk(error)) return
	if (shouldIgnoreBufferedError(error)) return
	try {
		if (captureImpl) {
			captureImpl(error, context)
			return
		}
		if (!pendingConfig) return
		enqueueBufferedError(error, context)
	} catch {
		// Reporting must never break the app.
	}
}
