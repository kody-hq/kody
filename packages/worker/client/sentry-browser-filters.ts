/**
 * Browser Sentry event filters. Kept free of `@sentry/browser` imports so unit
 * tests can exercise the predicates with plain event shapes.
 */

import {
	isBrowserFetchNetworkError,
	isBrowserFetchNetworkErrorMessage,
} from '#client/browser-fetch-network-error.ts'

type SentryStackFrame = {
	filename?: string
	abs_path?: string
	absPath?: string
	function?: string
}

type SentryExceptionValue = {
	type?: string
	value?: string
	stacktrace?: {
		frames?: Array<SentryStackFrame>
	}
}

type SentryBreadcrumbLike = {
	category?: string
	data?: {
		url?: string
		method?: string
		status_code?: number
	}
}

type SentryErrorEventLike = {
	message?: string
	exception?: {
		values?: Array<SentryExceptionValue>
	}
	breadcrumbs?: Array<SentryBreadcrumbLike>
}

function sentryEventMessages(event: SentryErrorEventLike) {
	return [
		event.message,
		...(event.exception?.values?.map((value) => value.value) ?? []),
	]
}

function sentryEventStackFrames(event: SentryErrorEventLike) {
	const frames: Array<SentryStackFrame> = []
	for (const value of event.exception?.values ?? []) {
		for (const frame of value.stacktrace?.frames ?? []) {
			frames.push(frame)
		}
	}
	return frames
}

function stackFrameUrls(frame: SentryStackFrame) {
	const urls: Array<string> = []
	for (const candidate of [frame.abs_path, frame.absPath, frame.filename]) {
		if (typeof candidate === 'string' && candidate.length > 0) {
			urls.push(candidate)
		}
	}
	return urls
}

function sentryEventStackFrameUrls(event: SentryErrorEventLike) {
	const urls: Array<string> = []
	for (const frame of sentryEventStackFrames(event)) {
		urls.push(...stackFrameUrls(frame))
	}
	return urls
}

function sentryEventStackFrameFunctions(event: SentryErrorEventLike) {
	const names: Array<string> = []
	for (const value of event.exception?.values ?? []) {
		for (const frame of value.stacktrace?.frames ?? []) {
			if (typeof frame.function === 'string' && frame.function.length > 0) {
				names.push(frame.function)
			}
		}
	}
	return names
}

/**
 * Chromium/Edge fetch abort text from KODY-CLOUDFLARE-23 and common browser
 * variants. Matching is intentionally narrow: only these exact abort strings
 * (plus AbortError-named exceptions via `isBrowserAbortError`) — never
 * blanket-drop network errors or timeout wording.
 */
const browserAbortErrorMessages = new Set([
	'AbortError: The user aborted a request.',
	'The user aborted a request.',
	'AbortError: The operation was aborted.',
	'The operation was aborted.',
	'AbortError: aborted',
])

function isBrowserAbortErrorMessage(message: string) {
	return browserAbortErrorMessages.has(message)
}

export function isBrowserAbortError(error: unknown) {
	if (typeof error !== 'object' || error === null) return false
	return 'name' in error && error.name === 'AbortError'
}

/**
 * Drop expected browser AbortError noise (user navigated away, superseding
 * SPA navigation aborted an in-flight fetch, etc.). These surface as
 * unhandledrejection via `auto.browser.global_handlers.onunhandledrejection`
 * and are not actionable product defects.
 */
function isBrowserAbortSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	if (isBrowserAbortError(originalException)) return true
	if (
		event.exception?.values?.some(
			(value) =>
				value.type === 'AbortError' ||
				(value.type === 'DOMException' &&
					typeof value.value === 'string' &&
					isBrowserAbortErrorMessage(value.value)),
		)
	) {
		return true
	}
	return sentryEventMessages(event).some(
		(message) =>
			typeof message === 'string' && isBrowserAbortErrorMessage(message),
	)
}

export function filterBrowserAbortSentryEvent<T extends SentryErrorEventLike>(
	event: T,
	originalException?: unknown,
): T | null {
	if (isBrowserAbortSentryEvent(event, originalException)) return null
	return event
}

/**
 * Firefox throws when page JS (hydration or Sentry Session Replay /
 * rrweb `startRecording`) touches a DOM node the content compartment cannot
 * read — typically an extension-injected Xray wrapper or a cross-origin
 * object. Signature from production issue 7639685398 / MDN
 * "Permission denied to access property". Not actionable in app code.
 *
 * Match is intentionally narrow: only this Firefox wording (optional
 * "on cross-origin object" suffix). Never blanket-drop SecurityError /
 * DOMException generally.
 */
const firefoxDomPermissionDeniedMessage =
	/^Permission denied to access property ["'][^"']+["'](?: on cross-origin object)?\.?$/

function isFirefoxDomPermissionDeniedMessage(message: string) {
	return firefoxDomPermissionDeniedMessage.test(message)
}

export function isFirefoxDomPermissionDeniedError(error: unknown) {
	if (typeof error !== 'object' || error === null) return false
	if (!('message' in error) || typeof error.message !== 'string') return false
	return isFirefoxDomPermissionDeniedMessage(error.message)
}

function isFirefoxDomPermissionDeniedSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	if (isFirefoxDomPermissionDeniedError(originalException)) return true
	return sentryEventMessages(event).some(
		(message) =>
			typeof message === 'string' &&
			isFirefoxDomPermissionDeniedMessage(message),
	)
}

export function filterFirefoxDomPermissionDeniedSentryEvent<
	T extends SentryErrorEventLike,
>(event: T, originalException?: unknown): T | null {
	if (isFirefoxDomPermissionDeniedSentryEvent(event, originalException)) {
		return null
	}
	return event
}

/**
 * Wallet / browser-injected globals that throw from page `global code`, not
 * from Kody bundles (no app code references these). Production signatures from
 * Brave iOS issue 7648833360 and sibling 7648833403:
 * - `undefined is not an object (evaluating 'window.ethereum…')`
 * - `undefined is not an object (evaluating 'window.__firefox__…')`
 * - `Can't find variable: __firefox__`
 *
 * Match is intentionally narrow: only these injected-global access patterns.
 * Never blanket-drop TypeError / ReferenceError.
 */
function isBrowserInjectedGlobalNoiseMessage(message: string) {
	const withoutTypePrefix = message
		.trim()
		.replace(/^(?:TypeError|ReferenceError):\s*/i, '')
	return (
		/^undefined is not an object \(evaluating ['"]window\.(?:ethereum|__firefox__)\./i.test(
			withoutTypePrefix,
		) ||
		/^Can'?t find variable: __firefox__\.?$/i.test(withoutTypePrefix) ||
		/^Cannot find variable: __firefox__\.?$/i.test(withoutTypePrefix) ||
		/^__firefox__ is not defined\.?$/i.test(withoutTypePrefix)
	)
}

export function isBrowserInjectedGlobalNoiseError(error: unknown) {
	if (typeof error === 'string') {
		return isBrowserInjectedGlobalNoiseMessage(error)
	}
	if (typeof error !== 'object' || error === null) return false
	if (!('message' in error) || typeof error.message !== 'string') return false
	return isBrowserInjectedGlobalNoiseMessage(error.message)
}

function isBrowserInjectedGlobalNoiseSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	if (isBrowserInjectedGlobalNoiseError(originalException)) return true
	return sentryEventMessages(event).some(
		(message) =>
			typeof message === 'string' &&
			isBrowserInjectedGlobalNoiseMessage(message),
	)
}

export function filterBrowserInjectedGlobalNoiseSentryEvent<
	T extends SentryErrorEventLike,
>(event: T, originalException?: unknown): T | null {
	if (isBrowserInjectedGlobalNoiseSentryEvent(event, originalException)) {
		return null
	}
	return event
}

/**
 * Fathom Analytics (`cdn.usefathom.com/script.js`) tracks pageviews with a
 * temporary `<img>` beacon and removes it from `load`/`error` handlers via
 * `img.parentNode.removeChild(img)`. When the beacon was already detached
 * (SPA navigation / soft reload), `parentNode` is null and the browser throws.
 * Chromium: issue 7653117289 / KODY-CLOUDFLARE-3Q. Mobile Safari/WebKit:
 * issue 7661146106 / KODY-CLOUDFLARE-4C.
 *
 * Match is intentionally narrow: removeChild-on-null TypeError text AND a
 * stack frame attributable to the Fathom script (CDN hostname or the
 * cross-origin-sanitized `/script.js` path). Never blanket-drop removeChild
 * errors from app code.
 */
const fathomRemoveChildNullMessage =
	/^(?:(?:TypeError:\s*)?Cannot read propert(?:y|ies) of null \(reading ['"]removeChild['"]\)|(?:TypeError:\s*)?null is not an object \(evaluating ['"][^'"]*\.removeChild[^'"]*['"]\))$/

const fathomAnalyticsHostname = 'cdn.usefathom.com'

function isFathomRemoveChildNullMessage(message: string) {
	return fathomRemoveChildNullMessage.test(message.trim())
}

function isFathomAnalyticsStackFrameUrl(url: string) {
	try {
		if (
			new URL(url, 'https://sentry.invalid').hostname ===
			fathomAnalyticsHostname
		) {
			return true
		}
	} catch {
		// fall through to sanitized cross-origin paths
	}
	// Cross-origin Fathom frames often sanitize to "/script.js" in Sentry.
	const normalized = url.replace(/\\/g, '/')
	return normalized === '/script.js'
}

function isFathomRemoveChildNullSentryEvent(event: SentryErrorEventLike) {
	const hasRemoveChildNull = sentryEventMessages(event).some(
		(message) =>
			typeof message === 'string' && isFathomRemoveChildNullMessage(message),
	)
	if (!hasRemoveChildNull) return false
	return sentryEventStackFrameUrls(event).some(isFathomAnalyticsStackFrameUrl)
}

function filterFathomRemoveChildNullSentryEvent<T extends SentryErrorEventLike>(
	event: T,
): T | null {
	if (isFathomRemoveChildNullSentryEvent(event)) return null
	return event
}

/**
 * Chrome extension messaging noise: when an extension calls a Chrome API
 * (e.g. `tabs.update`) against an object id that no longer exists, Chromium
 * rejects with this exact IPC wording. The rejected promise is often
 * unhandled, so Sentry's `onunhandledrejection` handler captures it as a
 * non-Error rejection on the host page — with no app stack frames.
 *
 * Signature from production issue 7655189301 / KODY-CLOUDFLARE-3S (breadcrumb
 * showed an antifingerprint extension injecting into the then-production host
 * heykody.dev). Match is intentionally narrow: only this Chrome "Object Not
 * Found Matching Id…, MethodName…, ParamCount…" form (optionally wrapped by
 * Sentry's Non-Error rejection preface). Never blanket-drop UnhandledRejection.
 */
const chromeExtensionObjectNotFoundMessage =
	/(?:^|\b)Object Not Found Matching Id:\d+, MethodName:\w+, ParamCount:\d+\b/

function isChromeExtensionObjectNotFoundMessage(message: string) {
	return chromeExtensionObjectNotFoundMessage.test(message.trim())
}

function isChromeExtensionObjectNotFoundError(error: unknown) {
	if (typeof error === 'string') {
		return isChromeExtensionObjectNotFoundMessage(error)
	}
	if (typeof error !== 'object' || error === null) return false
	if (!('message' in error) || typeof error.message !== 'string') return false
	return isChromeExtensionObjectNotFoundMessage(error.message)
}

function isChromeExtensionObjectNotFoundSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	if (isChromeExtensionObjectNotFoundError(originalException)) return true
	return sentryEventMessages(event).some(
		(message) =>
			typeof message === 'string' &&
			isChromeExtensionObjectNotFoundMessage(message),
	)
}

function filterChromeExtensionObjectNotFoundSentryEvent<
	T extends SentryErrorEventLike,
>(event: T, originalException?: unknown): T | null {
	if (isChromeExtensionObjectNotFoundSentryEvent(event, originalException)) {
		return null
	}
	return event
}

/**
 * Chrome/Firefox extension messaging noise: content scripts and page-injected
 * extension code call `chrome.runtime.sendMessage` / `browser.runtime.sendMessage`
 * when the extension's background/service worker (or another receiving end) is
 * gone — unloaded, updated, or never registered for that tab. Chromium rejects
 * with this exact IPC wording. The promise often surfaces on the host page with
 * no app stack frames (Sentry attributes the culprit to the document URL).
 *
 * Signature from production issue 7662064169 / KODY-CLOUDFLARE-4F (Chrome on
 * then-production https://heykody.app/, zero frames, handled generic capture).
 * Kody never uses `chrome.runtime` / `browser.runtime`. Match is intentionally
 * narrow: only this exact "Could not establish connection. Receiving end does
 * not exist" wording (optional `Error:` preface). Never blanket-drop connection
 * errors.
 */
const chromeExtensionReceivingEndMissingMessage =
	/^(?:Error:\s*)?Could not establish connection\. Receiving end does not exist\.?$/

function isChromeExtensionReceivingEndMissingMessage(message: string) {
	return chromeExtensionReceivingEndMissingMessage.test(message.trim())
}

function isChromeExtensionReceivingEndMissingError(error: unknown) {
	if (typeof error === 'string') {
		return isChromeExtensionReceivingEndMissingMessage(error)
	}
	if (typeof error !== 'object' || error === null) return false
	if (!('message' in error) || typeof error.message !== 'string') return false
	return isChromeExtensionReceivingEndMissingMessage(error.message)
}

function isChromeExtensionReceivingEndMissingSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	if (isChromeExtensionReceivingEndMissingError(originalException)) return true
	return sentryEventMessages(event).some(
		(message) =>
			typeof message === 'string' &&
			isChromeExtensionReceivingEndMissingMessage(message),
	)
}

function filterChromeExtensionReceivingEndMissingSentryEvent<
	T extends SentryErrorEventLike,
>(event: T, originalException?: unknown): T | null {
	if (
		isChromeExtensionReceivingEndMissingSentryEvent(event, originalException)
	) {
		return null
	}
	return event
}

/**
 * Browser-extension messaging noise: content scripts / page-injected extension
 * code call `runtime.sendMessage` against a tab id that no longer exists
 * (closed, navigated away, or never created). Chromium (and Safari Web
 * Extensions that surface the same IPC wording) reject with this exact
 * message. The promise often surfaces on the host page via
 * `onunhandledrejection` with no app stack frames (Sentry attributes the
 * culprit to the document URL).
 *
 * Signature from production issue 7689579030 / KODY-CLOUDFLARE-5X (Mobile
 * Safari on https://kody.codes/, zero frames). Kody never uses
 * `chrome.runtime` / `browser.runtime`. Match is intentionally narrow: only
 * this exact "Invalid call to runtime.sendMessage(). Tab not found" wording
 * (optional `Error:` preface). Never blanket-drop sendMessage or tab errors.
 */
const chromeExtensionSendMessageTabNotFoundMessage =
	/^(?:Error:\s*)?Invalid call to runtime\.sendMessage\(\)\. Tab not found\.?$/

function isChromeExtensionSendMessageTabNotFoundMessage(message: string) {
	return chromeExtensionSendMessageTabNotFoundMessage.test(message.trim())
}

function isChromeExtensionSendMessageTabNotFoundError(error: unknown) {
	if (typeof error === 'string') {
		return isChromeExtensionSendMessageTabNotFoundMessage(error)
	}
	if (typeof error !== 'object' || error === null) return false
	if (!('message' in error) || typeof error.message !== 'string') return false
	return isChromeExtensionSendMessageTabNotFoundMessage(error.message)
}

function isChromeExtensionSendMessageTabNotFoundSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	if (isChromeExtensionSendMessageTabNotFoundError(originalException)) {
		return true
	}
	return sentryEventMessages(event).some(
		(message) =>
			typeof message === 'string' &&
			isChromeExtensionSendMessageTabNotFoundMessage(message),
	)
}

function filterChromeExtensionSendMessageTabNotFoundSentryEvent<
	T extends SentryErrorEventLike,
>(event: T, originalException?: unknown): T | null {
	if (
		isChromeExtensionSendMessageTabNotFoundSentryEvent(event, originalException)
	) {
		return null
	}
	return event
}

/**
 * MetaMask (`chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/…`) injects
 * `inpage.js` into every page and tries to restore a wallet session on load.
 * When the extension's background/service worker is unavailable it rejects
 * with "Failed to connect to MetaMask" / "MetaMask extension not found".
 * Signature from production issue 7658961865 / KODY-CLOUDFLARE-3X — stack is
 * exclusively the extension; Kody never touches MetaMask.
 *
 * Match is intentionally narrow: MetaMask connect-failure wording AND a stack
 * frame from MetaMask's published Chrome extension id. Never blanket-drop
 * chrome-extension frames or wallet-related TypeErrors from app code.
 */
const metaMaskConnectFailureMessage =
	/^(?:i:\s*)?(?:Failed to connect to MetaMask|MetaMask extension not found)\.?$/i

/** Published MetaMask Chrome Web Store extension id. */
const metaMaskChromeExtensionId = 'nkbihfbeogaeaoehlefnkodbefgpgknn'

function isMetaMaskConnectFailureMessage(message: string) {
	return metaMaskConnectFailureMessage.test(message.trim())
}

function isMetaMaskChromeExtensionStackFrameUrl(url: string) {
	try {
		const parsed = new URL(url, 'https://sentry.invalid')
		return (
			parsed.protocol === 'chrome-extension:' &&
			parsed.hostname === metaMaskChromeExtensionId
		)
	} catch {
		return false
	}
}

function isMetaMaskConnectFailureError(error: unknown) {
	if (typeof error === 'string') {
		return isMetaMaskConnectFailureMessage(error)
	}
	if (typeof error !== 'object' || error === null) return false
	if (!('message' in error) || typeof error.message !== 'string') return false
	return isMetaMaskConnectFailureMessage(error.message)
}

function isMetaMaskExtensionSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	const hasMetaMaskMessage =
		isMetaMaskConnectFailureError(originalException) ||
		sentryEventMessages(event).some(
			(message) =>
				typeof message === 'string' && isMetaMaskConnectFailureMessage(message),
		)
	if (!hasMetaMaskMessage) return false
	return sentryEventStackFrameUrls(event).some(
		isMetaMaskChromeExtensionStackFrameUrl,
	)
}

function filterMetaMaskExtensionSentryEvent<T extends SentryErrorEventLike>(
	event: T,
	originalException?: unknown,
): T | null {
	if (isMetaMaskExtensionSentryEvent(event, originalException)) return null
	return event
}

/**
 * MetaMask (and forks) inject `window.ethereum` and sometimes reject on the
 * host page with a plain EIP-1193-shaped object `{ code, message }` when the
 * extension vault has no usable account. Sentry then synthesizes
 * "Object captured as exception with keys: code, message" because the
 * rejection is not an `Error`. Signature from production issue 7696001937 /
 * KODY-CLOUDFLARE-64 on `/` (`code: 4001`, message
 * `"wallet must has at least one account"` — known MetaMask grammar).
 *
 * Pre-SDK buffering attributes the flush stack to `captureBrowserException`,
 * so there are no chrome-extension frames to require. Match is intentionally
 * narrow: this exact MetaMask "wallet must has at least one account" wording
 * (optional `Error:` preface; tolerate corrected "have"). Never blanket-drop
 * EIP-1193 `4001` or other `{ code, message }` objects.
 */
const metaMaskWalletNoAccountMessage =
	/^(?:Error:\s*)?wallet must ha(?:s|ve) at least one account\.?$/i

function isMetaMaskWalletNoAccountMessage(message: string) {
	return metaMaskWalletNoAccountMessage.test(message.trim())
}

export function isMetaMaskWalletNoAccountError(error: unknown) {
	if (typeof error === 'string') {
		return isMetaMaskWalletNoAccountMessage(error)
	}
	if (typeof error !== 'object' || error === null) return false
	if (!('message' in error) || typeof error.message !== 'string') return false
	return isMetaMaskWalletNoAccountMessage(error.message)
}

function isMetaMaskWalletNoAccountSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	if (isMetaMaskWalletNoAccountError(originalException)) return true
	return sentryEventMessages(event).some(
		(message) =>
			typeof message === 'string' && isMetaMaskWalletNoAccountMessage(message),
	)
}

function filterMetaMaskWalletNoAccountSentryEvent<
	T extends SentryErrorEventLike,
>(event: T, originalException?: unknown): T | null {
	if (isMetaMaskWalletNoAccountSentryEvent(event, originalException)) {
		return null
	}
	return event
}

/**
 * Rabby Wallet (`chrome-extension://acmacodkjbdgmoleebolmdjonilkdbch/…`) and
 * sibling Chrome extensions reject page-injected messaging with
 * `MessageDisconnectedError: Message channel disconnected` when the
 * extension's message channel is gone (reload, update, or tab teardown).
 * The rejection often surfaces as a plain object `{ code, message, stack }`
 * (EIP-1193-shaped, `code: 4900`) via buffered `unhandledrejection` →
 * `captureBrowserException` flush. Sentry synthesizes "Object captured as
 * exception with keys: code, message, stack" because the rejection is not
 * an `Error`. Signature from production issue 7715934699 / KODY-72 —
 * flush stack is only our capture path (no chrome-extension frames on the
 * event); `__serialized__` holds the Rabby object.
 *
 * Pre-SDK buffering attributes the flush stack to `captureBrowserException`,
 * so there are no chrome-extension event frames to require (unlike
 * Client-has-been-destroyed). Match requires the exact wording (optional
 * `MessageDisconnectedError:` / `Error:` preface) AND extension provenance:
 * EIP-1193 `code === 4900`, a string `stack` containing `chrome-extension:`,
 * or (for Sentry events without a matching originalException) at least one
 * `chrome-extension:` stack frame. Never drop a first-party Error that only
 * shares the message, bare strings with no provenance, unrelated
 * `{ code, message, stack }` objects, or EIP-1193 `4900` with other messages.
 */
const chromeExtensionMessageChannelDisconnectedMessage =
	/^(?:(?:MessageDisconnectedError|Error):\s*)?Message channel disconnected\.?$/i

function isChromeExtensionMessageChannelDisconnectedMessage(message: string) {
	return chromeExtensionMessageChannelDisconnectedMessage.test(message.trim())
}

function isChromeExtensionStackFrameUrl(url: string) {
	try {
		return (
			new URL(url, 'https://sentry.invalid').protocol === 'chrome-extension:'
		)
	} catch {
		return false
	}
}

function hasChromeExtensionMessageChannelDisconnectedEvidence(
	error: object,
): boolean {
	if ('code' in error && error.code === 4900) return true
	if (
		'stack' in error &&
		typeof error.stack === 'string' &&
		error.stack.includes('chrome-extension:')
	) {
		return true
	}
	return false
}

export function isChromeExtensionMessageChannelDisconnectedError(
	error: unknown,
) {
	// Bare strings have no extension provenance — keep them visible.
	if (typeof error === 'string') return false
	if (typeof error !== 'object' || error === null) return false
	if (!('message' in error) || typeof error.message !== 'string') return false
	if (!isChromeExtensionMessageChannelDisconnectedMessage(error.message)) {
		return false
	}
	return hasChromeExtensionMessageChannelDisconnectedEvidence(error)
}

function isChromeExtensionMessageChannelDisconnectedSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	if (isChromeExtensionMessageChannelDisconnectedError(originalException)) {
		return true
	}

	// Same-entry gate: never pair a matching message from one exception
	// value with a chrome-extension frame from another (Devin on #3917).
	const values = event.exception?.values ?? []
	if (values.length > 0) {
		return values.some((value) => {
			if (typeof value.value !== 'string') return false
			if (!isChromeExtensionMessageChannelDisconnectedMessage(value.value)) {
				return false
			}
			return (value.stacktrace?.frames ?? []).some((frame) =>
				stackFrameUrls(frame).some(isChromeExtensionStackFrameUrl),
			)
		})
	}

	if (
		typeof event.message !== 'string' ||
		!isChromeExtensionMessageChannelDisconnectedMessage(event.message)
	) {
		return false
	}
	return sentryEventStackFrameUrls(event).some(isChromeExtensionStackFrameUrl)
}

function filterChromeExtensionMessageChannelDisconnectedSentryEvent<
	T extends SentryErrorEventLike,
>(event: T, originalException?: unknown): T | null {
	if (
		isChromeExtensionMessageChannelDisconnectedSentryEvent(
			event,
			originalException,
		)
	) {
		return null
	}
	return event
}

/**
 * Chrome extension page hooks reject with "Client has been destroyed" when
 * their background/service-worker client is gone (reload, update, or tab
 * teardown). The rejected promise surfaces on the host page via
 * `onunhandledrejection` with a stack that is exclusively chrome-extension
 * frames — never Kody bundles. Signature from production issue 7682968915 /
 * KODY-CLOUDFLARE-5K (`WrappedError: Client has been destroyed` from
 * `chrome-extension://…/injected-scripts/host-additional-hooks.js`).
 *
 * Match is intentionally narrow: this exact wording (optional
 * `WrappedError:` / `Error:` preface) AND every reported stack frame URL is
 * `chrome-extension:`. Never blanket-drop "destroyed" wording from app code
 * or mixed stacks that include first-party frames.
 */
const chromeExtensionClientDestroyedMessage =
	/^(?:(?:WrappedError|Error):\s*)?Client has been destroyed\.?$/i

function isChromeExtensionClientDestroyedMessage(message: string) {
	return chromeExtensionClientDestroyedMessage.test(message.trim())
}

function isChromeExtensionClientDestroyedError(error: unknown) {
	if (typeof error === 'string') {
		return isChromeExtensionClientDestroyedMessage(error)
	}
	if (typeof error !== 'object' || error === null) return false
	if (!('message' in error) || typeof error.message !== 'string') return false
	return isChromeExtensionClientDestroyedMessage(error.message)
}

function isChromeExtensionClientDestroyedSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	const hasClientDestroyedMessage =
		isChromeExtensionClientDestroyedError(originalException) ||
		sentryEventMessages(event).some(
			(message) =>
				typeof message === 'string' &&
				isChromeExtensionClientDestroyedMessage(message),
		)
	if (!hasClientDestroyedMessage) return false
	const frameUrls = sentryEventStackFrameUrls(event)
	return frameUrls.length > 0 && frameUrls.every(isChromeExtensionStackFrameUrl)
}

function filterChromeExtensionClientDestroyedSentryEvent<
	T extends SentryErrorEventLike,
>(event: T, originalException?: unknown): T | null {
	if (isChromeExtensionClientDestroyedSentryEvent(event, originalException)) {
		return null
	}
	return event
}

/**
 * Some Chrome extensions wrap `performance` accessors in a recursive
 * `Performance.get` proxy and blow the call stack on the host page. Sentry
 * attributes the RangeError to the document because the promise rejects in
 * page context, but every real frame is `chrome-extension://…` (plus
 * engine-native `<anonymous>` / `[native code]` frames). Signature from
 * production issues 7690314544 / 7690316805 (`chrome-extension://nmpbkb…
 * /data/content_script/page_context/inject.js`).
 *
 * Match is intentionally narrow: Maximum call stack size exceeded wording,
 * at least one `chrome-extension:` frame, and every reported frame URL is
 * either `chrome-extension:` or anonymous/native. Never blanket-drop stack
 * overflows that include first-party or http(s) frames.
 */
const chromeExtensionCallStackExceededMessage =
	/^(?:(?:RangeError|Error):\s*)?Maximum call stack size exceeded\.?$/i

function isChromeExtensionCallStackExceededMessage(message: string) {
	return chromeExtensionCallStackExceededMessage.test(message.trim())
}

function isAnonymousOrNativeStackFrameUrl(url: string) {
	const trimmed = url.trim()
	return (
		trimmed.length === 0 ||
		trimmed === '<anonymous>' ||
		trimmed === '[native code]' ||
		trimmed === 'native'
	)
}

function isChromeExtensionOrAnonymousStackFrameUrl(url: string) {
	return (
		isAnonymousOrNativeStackFrameUrl(url) || isChromeExtensionStackFrameUrl(url)
	)
}

function isChromeExtensionCallStackExceededError(error: unknown) {
	if (typeof error === 'string') {
		return isChromeExtensionCallStackExceededMessage(error)
	}
	if (typeof error !== 'object' || error === null) return false
	if (!('message' in error) || typeof error.message !== 'string') return false
	return isChromeExtensionCallStackExceededMessage(error.message)
}

function isChromeExtensionCallStackExceededSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	const hasCallStackMessage =
		isChromeExtensionCallStackExceededError(originalException) ||
		event.exception?.values?.some(
			(value) =>
				value.type === 'RangeError' &&
				typeof value.value === 'string' &&
				isChromeExtensionCallStackExceededMessage(value.value),
		) ||
		sentryEventMessages(event).some(
			(message) =>
				typeof message === 'string' &&
				isChromeExtensionCallStackExceededMessage(message),
		)
	if (!hasCallStackMessage) return false
	const frameUrls = sentryEventStackFrameUrls(event)
	if (frameUrls.length === 0) return false
	if (!frameUrls.some(isChromeExtensionStackFrameUrl)) return false
	return frameUrls.every(isChromeExtensionOrAnonymousStackFrameUrl)
}

function filterChromeExtensionCallStackExceededSentryEvent<
	T extends SentryErrorEventLike,
>(event: T, originalException?: unknown): T | null {
	if (isChromeExtensionCallStackExceededSentryEvent(event, originalException)) {
		return null
	}
	return event
}

/**
 * Chrome extensions that inject page-context executors sometimes throw a
 * minified TypeError reading `M_ID` on an undefined object. Sentry's generic
 * handler captures it on the host page, but every real frame is
 * `chrome-extension://…/executors/…`. Signature from production issue
 * 7717003182 / KODY-74 on `/` (`Cannot read properties of undefined (reading
 * 'M_ID')`). Kody never references `M_ID`.
 *
 * Match is intentionally narrow: this exact Chromium TypeError wording
 * (optional `TypeError:` preface; older "property 'M_ID' of undefined" form)
 * AND every reported stack frame URL is `chrome-extension:` (anonymous /
 * native frames allowed). Never blanket-drop undefined-property TypeErrors
 * from app code or mixed stacks that include first-party frames.
 */
const chromeExtensionUndefinedMIdMessage =
	/^(?:TypeError:\s*)?(?:Cannot read properties of undefined \(reading ['"]M_ID['"]\)|Cannot read property ['"]M_ID['"] of undefined)\.?$/

function isChromeExtensionUndefinedMIdMessage(message: string) {
	return chromeExtensionUndefinedMIdMessage.test(message.trim())
}

function isChromeExtensionUndefinedMIdError(error: unknown) {
	if (typeof error === 'string') {
		return isChromeExtensionUndefinedMIdMessage(error)
	}
	if (typeof error !== 'object' || error === null) return false
	if (!('message' in error) || typeof error.message !== 'string') return false
	return isChromeExtensionUndefinedMIdMessage(error.message)
}

function isChromeExtensionUndefinedMIdSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	const hasMIdMessage =
		isChromeExtensionUndefinedMIdError(originalException) ||
		event.exception?.values?.some(
			(value) =>
				value.type === 'TypeError' &&
				typeof value.value === 'string' &&
				isChromeExtensionUndefinedMIdMessage(value.value),
		) ||
		sentryEventMessages(event).some(
			(message) =>
				typeof message === 'string' &&
				isChromeExtensionUndefinedMIdMessage(message),
		)
	if (!hasMIdMessage) return false
	return isChromeExtensionOnlyReportedStack(event)
}

/**
 * Drop-safe only when every reported frame is present and is either
 * `chrome-extension:` or an explicit anonymous/native marker. A URL-less
 * frame is treated as unknown (possibly first-party) and keeps the event.
 */
function isChromeExtensionOnlyReportedStack(event: SentryErrorEventLike) {
	const frames = sentryEventStackFrames(event)
	if (frames.length === 0) return false
	let hasChromeExtension = false
	for (const frame of frames) {
		const urls = stackFrameUrls(frame)
		if (urls.length === 0) return false
		if (!urls.every(isChromeExtensionOrAnonymousStackFrameUrl)) return false
		if (urls.some(isChromeExtensionStackFrameUrl)) {
			hasChromeExtension = true
		}
	}
	return hasChromeExtension
}

function filterChromeExtensionUndefinedMIdSentryEvent<
	T extends SentryErrorEventLike,
>(event: T, originalException?: unknown): T | null {
	if (isChromeExtensionUndefinedMIdSentryEvent(event, originalException)) {
		return null
	}
	return event
}

/**
 * Twitter/X iOS in-app browser chrome (`updateFooterPositions` /
 * `updateGapFiller`) references a host-page `CONFIG` global that Kody never
 * defines. WebKit reports it as an unhandled `ReferenceError` attributed to
 * the document URL (no Twitter bundle frames). Signature from production
 * issue 7659616372 / KODY-CLOUDFLARE-43 (browser tag "Twitter 11.82").
 *
 * Match is intentionally narrow: CONFIG ReferenceError wording AND a stack
 * frame named `updateFooterPositions` or `updateGapFiller`. Never
 * blanket-drop bare `CONFIG` ReferenceErrors from app code.
 */
const twitterInAppBrowserConfigMessage =
	/^(?:ReferenceError:\s*)?(?:Can'?t find variable: CONFIG|Cannot find variable: CONFIG|CONFIG is not defined)\.?$/i

const twitterInAppBrowserChromeFunctions = new Set([
	'updateFooterPositions',
	'updateGapFiller',
])

function isTwitterInAppBrowserConfigMessage(message: string) {
	return twitterInAppBrowserConfigMessage.test(message.trim())
}

function isTwitterInAppBrowserChromeStackFunction(name: string) {
	return twitterInAppBrowserChromeFunctions.has(name)
}

function isTwitterInAppBrowserConfigError(error: unknown) {
	if (typeof error === 'string') {
		return isTwitterInAppBrowserConfigMessage(error)
	}
	if (typeof error !== 'object' || error === null) return false
	if (!('message' in error) || typeof error.message !== 'string') return false
	return isTwitterInAppBrowserConfigMessage(error.message)
}

function isTwitterInAppBrowserConfigSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	const hasConfigMessage =
		isTwitterInAppBrowserConfigError(originalException) ||
		sentryEventMessages(event).some(
			(message) =>
				typeof message === 'string' &&
				isTwitterInAppBrowserConfigMessage(message),
		)
	if (!hasConfigMessage) return false
	return sentryEventStackFrameFunctions(event).some(
		isTwitterInAppBrowserChromeStackFunction,
	)
}

function filterTwitterInAppBrowserConfigSentryEvent<
	T extends SentryErrorEventLike,
>(event: T, originalException?: unknown): T | null {
	if (isTwitterInAppBrowserConfigSentryEvent(event, originalException)) {
		return null
	}
	return event
}

/**
 * Twitter/X iOS in-app browser chrome (`sendScrollEvent`) reaches for the
 * WKWebView bridge `window.webkit.messageHandlers` without guarding
 * `window.webkit`. Outside a native WebView host that exposes the bridge,
 * WebKit throws and Sentry attributes the frame to the document URL (no
 * Twitter bundle frames). Signature from production issue 7677729361 /
 * KODY-CLOUDFLARE-5C (browser tag "Twitter 12.14", iPhone).
 *
 * Match is intentionally narrow: WebKit `window.webkit.messageHandlers`
 * TypeError wording AND a stack frame named `sendScrollEvent`. Never
 * blanket-drop bare `webkit` TypeErrors from app code.
 */
const twitterInAppBrowserWebkitMessageHandlersMessage =
	/^(?:TypeError:\s*)?undefined is not an object \(evaluating ['"]window\.webkit\.messageHandlers(?:\.[^'"]*)?['"]\)$/i

function isTwitterInAppBrowserWebkitMessageHandlersMessage(message: string) {
	return twitterInAppBrowserWebkitMessageHandlersMessage.test(message.trim())
}

function isTwitterInAppBrowserWebkitMessageHandlersError(error: unknown) {
	if (typeof error === 'string') {
		return isTwitterInAppBrowserWebkitMessageHandlersMessage(error)
	}
	if (typeof error !== 'object' || error === null) return false
	if (!('message' in error) || typeof error.message !== 'string') return false
	return isTwitterInAppBrowserWebkitMessageHandlersMessage(error.message)
}

function isTwitterInAppBrowserWebkitMessageHandlersSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	const hasWebkitMessage =
		isTwitterInAppBrowserWebkitMessageHandlersError(originalException) ||
		sentryEventMessages(event).some(
			(message) =>
				typeof message === 'string' &&
				isTwitterInAppBrowserWebkitMessageHandlersMessage(message),
		)
	if (!hasWebkitMessage) return false
	return sentryEventStackFrameFunctions(event).some(
		(name) => name === 'sendScrollEvent',
	)
}

function filterTwitterInAppBrowserWebkitMessageHandlersSentryEvent<
	T extends SentryErrorEventLike,
>(event: T, originalException?: unknown): T | null {
	if (
		isTwitterInAppBrowserWebkitMessageHandlersSentryEvent(
			event,
			originalException,
		)
	) {
		return null
	}
	return event
}

/**
 * Injected page scripts (Mobile Safari / in-app browsers / content scripts)
 * sometimes probe Open Graph tags with an unguarded
 * `document.querySelector("meta[property='og:type']").content`. When the page
 * has no managed OG tags (guides and many authenticated routes), WebKit throws
 * and Sentry attributes the frame to `global code` on the document URL — never a Kody
 * bundle. Signature from production issue 7660258027 / KODY-CLOUDFLARE-46.
 *
 * Kody only writes `og:type` in document-head / SSR; it never reads it this
 * way. Match is intentionally narrow: Safari "null is not an object
 * (evaluating 'document.querySelector(…og:type…).content')" wording AND a
 * `global code` stack function. Never blanket-drop bare `.content` TypeErrors
 * from app code.
 */
const ogTypeMetaQuerySelectorContentMessage =
	/^(?:TypeError:\s*)?null is not an object \(evaluating ['"]document\.querySelector\([^)]*meta\[property=['"]og:type['"]\][^)]*\)\.content['"]\)$/i

function isOgTypeMetaQuerySelectorContentMessage(message: string) {
	return ogTypeMetaQuerySelectorContentMessage.test(message.trim())
}

function isOgTypeMetaQuerySelectorContentError(error: unknown) {
	if (typeof error === 'string') {
		return isOgTypeMetaQuerySelectorContentMessage(error)
	}
	if (typeof error !== 'object' || error === null) return false
	if (!('message' in error) || typeof error.message !== 'string') return false
	return isOgTypeMetaQuerySelectorContentMessage(error.message)
}

function isOgTypeMetaQuerySelectorContentSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	const hasOgTypeMessage =
		isOgTypeMetaQuerySelectorContentError(originalException) ||
		sentryEventMessages(event).some(
			(message) =>
				typeof message === 'string' &&
				isOgTypeMetaQuerySelectorContentMessage(message),
		)
	if (!hasOgTypeMessage) return false
	return sentryEventStackFrameFunctions(event).some(
		(name) => name === 'global code',
	)
}

function filterOgTypeMetaQuerySelectorContentSentryEvent<
	T extends SentryErrorEventLike,
>(event: T, originalException?: unknown): T | null {
	if (isOgTypeMetaQuerySelectorContentSentryEvent(event, originalException)) {
		return null
	}
	return event
}

/**
 * Web Worker `importScripts` failing to load a `blob:` URL. Observed when a
 * page navigates away (or HeadlessChrome tears down) while an editor/worker
 * blob is still booting — KODY-CLOUDFLARE-5G on `/@…/files`. Not an app defect;
 * match only this WorkerGlobalScope + blob: signature.
 */
const browserBlobImportScriptsNetworkErrorMessage =
	/Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at 'blob:[^']+' failed to load\.?/i

function isBrowserBlobImportScriptsNetworkErrorMessage(message: string) {
	return browserBlobImportScriptsNetworkErrorMessage.test(message.trim())
}

function isBrowserBlobImportScriptsNetworkError(error: unknown) {
	if (typeof error === 'string') {
		return isBrowserBlobImportScriptsNetworkErrorMessage(error)
	}
	if (typeof error !== 'object' || error === null) return false
	if (!('message' in error) || typeof error.message !== 'string') return false
	return isBrowserBlobImportScriptsNetworkErrorMessage(error.message)
}

function isBrowserBlobImportScriptsNetworkSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	if (isBrowserBlobImportScriptsNetworkError(originalException)) return true
	return sentryEventMessages(event).some(
		(message) =>
			typeof message === 'string' &&
			isBrowserBlobImportScriptsNetworkErrorMessage(message),
	)
}

function filterBrowserBlobImportScriptsNetworkSentryEvent<
	T extends SentryErrorEventLike,
>(event: T, originalException?: unknown): T | null {
	if (isBrowserBlobImportScriptsNetworkSentryEvent(event, originalException)) {
		return null
	}
	return event
}

/**
 * Transient browser `fetch()` network failures from TanStack Start server
 * function RPC (KODY-9Q / issue 7798170337). After the Start migration,
 * `createServerFn` client calls hit `/_serverFn/…`; when the tab resumes
 * offline/asleep (or the network blips), WebKit rejects with TypeError
 * `Load failed`, Chromium with `Failed to fetch`, Firefox with
 * `NetworkError when attempting to fetch resource.`. Root capture is the
 * router's `defaultOnCatch: captureClientException` and root
 * `refreshOnActivation` → `onError: captureClientException` (handled).
 * Tab-resume refresh keeps existing Query data; no error boundary.
 *
 * Match only browser fetch-network TypeError wording (see
 * `isBrowserFetchNetworkError`) AND serverFn evidence:
 * - stack/frames naming `serverFnFetcher` / `createServerFn` (dev or
 *   source-mapped stacks), OR
 * - a Sentry fetch/xhr breadcrumb whose URL contains `/_serverFn` (production
 *   `beforeSend` sees bundled `/assets/…` frames; source maps apply after
 *   send, so module names are unavailable client-side).
 *
 * Multi-value events (linked `cause` chains) drop only when **every** value
 * is a qualifying fetch-network TypeError — a reportable app exception with
 * a network TypeError cause must stay visible. Never blanket-drop bare
 * "Failed to fetch" / in-app TypeErrors.
 */
const tanStackServerFnFetchStackToken = /serverFnFetcher|createServerFn/
const tanStackServerFnBreadcrumbUrl = /\/_serverFn(?:\/|$|\?)/i

function textMentionsTanStackServerFnFetch(text: string) {
	return tanStackServerFnFetchStackToken.test(text)
}

function framesMentionTanStackServerFnFetch(
	frames: Array<SentryStackFrame> | undefined,
) {
	if (!frames || frames.length === 0) return false
	for (const frame of frames) {
		if (
			typeof frame.function === 'string' &&
			textMentionsTanStackServerFnFetch(frame.function)
		) {
			return true
		}
		for (const url of stackFrameUrls(frame)) {
			if (textMentionsTanStackServerFnFetch(url)) return true
		}
	}
	return false
}

function originalExceptionMentionsTanStackServerFnFetch(error: unknown) {
	if (typeof error !== 'object' || error === null) return false
	const stack =
		'stack' in error && typeof error.stack === 'string' ? error.stack : ''
	return textMentionsTanStackServerFnFetch(stack)
}

function eventHasTanStackServerFnFetchBreadcrumb(event: SentryErrorEventLike) {
	for (const crumb of event.breadcrumbs ?? []) {
		if (crumb.category !== 'fetch' && crumb.category !== 'xhr') continue
		const url = crumb.data?.url
		if (typeof url === 'string' && tanStackServerFnBreadcrumbUrl.test(url)) {
			return true
		}
	}
	return false
}

function isTanStackServerFnFetchNetworkExceptionMessage(
	value: SentryExceptionValue,
) {
	if (value.type !== 'TypeError') return false
	return (
		typeof value.value === 'string' &&
		isBrowserFetchNetworkErrorMessage(value.value)
	)
}

export function isTanStackServerFnFetchNetworkError(error: unknown) {
	if (!isBrowserFetchNetworkError(error)) return false
	return originalExceptionMentionsTanStackServerFnFetch(error)
}

function isTanStackServerFnFetchNetworkSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	// Every-value gate for linked causes (CodeRabbit): drop only when every
	// exception value is a fetch-network TypeError. A reportable app Error
	// wrapping a network TypeError cause must stay visible.
	const values = event.exception?.values ?? []
	if (values.length === 0) {
		return isTanStackServerFnFetchNetworkError(originalException)
	}
	if (!values.every(isTanStackServerFnFetchNetworkExceptionMessage)) {
		return false
	}
	// Evidence: production beforeSend uses /_serverFn breadcrumbs (bundled
	// /assets frames lack module names); unminified stacks / originalException
	// may still name serverFnFetcher / createServerFn.
	if (eventHasTanStackServerFnFetchBreadcrumb(event)) return true
	if (isTanStackServerFnFetchNetworkError(originalException)) return true
	return values.every((value) =>
		framesMentionTanStackServerFnFetch(value.stacktrace?.frames),
	)
}

function filterTanStackServerFnFetchNetworkSentryEvent<
	T extends SentryErrorEventLike,
>(event: T, originalException?: unknown): T | null {
	if (isTanStackServerFnFetchNetworkSentryEvent(event, originalException)) {
		return null
	}
	return event
}

/**
 * Stale Start release after a deploy: a browser tab still holding a previous
 * client build calls `/__start/<old-hash>/_serverFn/...`, gets HTTP 404 with
 * body exactly `Unknown Start release.`, and the createServerFn client throws
 * that into Sentry (KODY-9E / issue 7795797021 on `/account`). Expected
 * post-deploy stale-tab noise — not an app defect. Match only this exact
 * wording (optional `Error:` preface). Never blanket-drop other "Unknown …"
 * errors. Client recovery is a one-shot hard reload (see
 * `reload-on-unknown-start-release.ts`).
 */
const unknownStartReleaseMessage = /^(?:Error:\s*)?Unknown Start release\.?$/

function isUnknownStartReleaseMessage(message: string) {
	return unknownStartReleaseMessage.test(message.trim())
}

export function isUnknownStartReleaseError(error: unknown) {
	if (typeof error === 'string') {
		return isUnknownStartReleaseMessage(error)
	}
	if (typeof error !== 'object' || error === null) return false
	if (!('message' in error) || typeof error.message !== 'string') return false
	return isUnknownStartReleaseMessage(error.message)
}

function isUnknownStartReleaseSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	if (isUnknownStartReleaseError(originalException)) return true
	return sentryEventMessages(event).some(
		(message) =>
			typeof message === 'string' && isUnknownStartReleaseMessage(message),
	)
}

function filterUnknownStartReleaseSentryEvent<T extends SentryErrorEventLike>(
	event: T,
	originalException?: unknown,
): T | null {
	if (isUnknownStartReleaseSentryEvent(event, originalException)) {
		return null
	}
	return event
}

/**
 * Optional Shiki chunk failed to load (`import('./syntax-highlight-core')`).
 * Observed as an unhandledrejection on `/` when the homepage landing loop
 * fire-and-forgot the preload without a catch (KODY-CLOUDFLARE-5W, Mobile
 * Safari). Fences already render as escaped plaintext until the chunk
 * resolves, so this is expected degradation — not an app defect. Match only
 * the browser "Failed to fetch dynamically imported module" signature with
 * `syntax-highlight-core` in the URL so other chunk-load failures stay
 * Sentry-visible (route boot still reloads on stale area hashes).
 */
const syntaxHighlightCoreDynamicImportFailureMessage =
	/Failed to fetch dynamically imported module:\s*\S*syntax-highlight-core[^/\s]*\.js/i

function isSyntaxHighlightCoreDynamicImportFailureMessage(message: string) {
	return syntaxHighlightCoreDynamicImportFailureMessage.test(message.trim())
}

export function isSyntaxHighlightCoreDynamicImportFailureError(error: unknown) {
	if (typeof error === 'string') {
		return isSyntaxHighlightCoreDynamicImportFailureMessage(error)
	}
	if (typeof error !== 'object' || error === null) return false
	if (!('message' in error) || typeof error.message !== 'string') return false
	return isSyntaxHighlightCoreDynamicImportFailureMessage(error.message)
}

function isSyntaxHighlightCoreDynamicImportFailureSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	if (isSyntaxHighlightCoreDynamicImportFailureError(originalException)) {
		return true
	}
	return sentryEventMessages(event).some(
		(message) =>
			typeof message === 'string' &&
			isSyntaxHighlightCoreDynamicImportFailureMessage(message),
	)
}

function filterSyntaxHighlightCoreDynamicImportFailureSentryEvent<
	T extends SentryErrorEventLike,
>(event: T, originalException?: unknown): T | null {
	if (
		isSyntaxHighlightCoreDynamicImportFailureSentryEvent(
			event,
			originalException,
		)
	) {
		return null
	}
	return event
}

/**
 * Local `npm run dev` Vite / wrangler sessions (KODY-6Z, KODY-6T, KODY-6Y).
 * Production wrangler vars copy `SENTRY_ENVIRONMENT=production` into local
 * Vite, so HMR identity/CSS-binding crashes report as production. Match only
 * loopback stack URLs or Vite dependency URLs. Production failures stay visible.
 */
const loopbackHttpUrlPattern =
	/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i
const viteDevStackTokenPattern = /\/\.vite\//i

function stackTextLooksLikeLocalViteDev(text: string) {
	return (
		loopbackHttpUrlPattern.test(text) || viteDevStackTokenPattern.test(text)
	)
}

export function isLocalViteDevError(error: unknown) {
	if (typeof error !== 'object' || error === null) return false
	const stack =
		'stack' in error && typeof error.stack === 'string' ? error.stack : ''
	return stackTextLooksLikeLocalViteDev(stack)
}

function isLocalViteDevSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	if (isLocalViteDevError(originalException)) return true
	return sentryEventStackFrameUrls(event).some(stackTextLooksLikeLocalViteDev)
}

function filterLocalViteDevSentryEvent<T extends SentryErrorEventLike>(
	event: T,
	originalException?: unknown,
): T | null {
	if (isLocalViteDevSentryEvent(event, originalException)) return null
	return event
}

/**
 * Cloudflare Turnstile client failures that are visitor-environment or
 * challenge-edge noise, not app defects (KODY-6D script blocked by
 * ad-blocker / network; KODY-6E TurnstileError 300* generic challenge
 * failure). Match only our exact load/init strings and Turnstile's own
 * `[Cloudflare Turnstile] Error: NNNNNN` / `TurnstileError` signature so
 * unrelated Errors stay Sentry-visible.
 */
const cloudflareTurnstileClientErrorMessage =
	/^(?:Error:\s*)?(?:Turnstile script failed to load\.|Turnstile API did not initialize\.|\[Cloudflare Turnstile\] Error: \d+\.?)$/i

function isCloudflareTurnstileClientErrorMessage(message: string) {
	return cloudflareTurnstileClientErrorMessage.test(message.trim())
}

export function isCloudflareTurnstileClientError(error: unknown) {
	if (typeof error === 'string') {
		return isCloudflareTurnstileClientErrorMessage(error)
	}
	if (typeof error !== 'object' || error === null) return false
	const name =
		'name' in error && typeof error.name === 'string' ? error.name : undefined
	if (name === 'TurnstileError') return true
	if (!('message' in error) || typeof error.message !== 'string') return false
	return isCloudflareTurnstileClientErrorMessage(error.message)
}

function isCloudflareTurnstileClientSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	if (isCloudflareTurnstileClientError(originalException)) return true
	if (
		event.exception?.values?.some((value) => value.type === 'TurnstileError')
	) {
		return true
	}
	return sentryEventMessages(event).some(
		(message) =>
			typeof message === 'string' &&
			isCloudflareTurnstileClientErrorMessage(message),
	)
}

function filterCloudflareTurnstileClientSentryEvent<
	T extends SentryErrorEventLike,
>(event: T, originalException?: unknown): T | null {
	if (isCloudflareTurnstileClientSentryEvent(event, originalException)) {
		return null
	}
	return event
}

/**
 * Sentry Session Replay / rrweb cross-origin iframe instrumentation noise
 * (getsentry/sentry-javascript#23795 / KODY-8W, issue 7777463624).
 * `ShadowDomManager.observeAttachShadow` reads `iframeWindow.Element`
 * without a try/catch. For a cross-origin frame `contentWindow` is a truthy
 * restricted proxy, so the read throws into the host page via Replay's
 * iframe `load` listener (`onIframeLoad` → `observeAttachShadow`).
 *
 * Primary mitigation is `block: ['iframe']` in `replayIntegration` (see
 * `sentry-init.ts`). This filter is the residual beforeSend gate for events
 * that still escape (older clients, race before block applies, TypeError
 * variant when `Element` is undefined). Match is intentionally narrow:
 * SecurityError / DOMException "Failed to read a named property 'Element'"
 * cross-origin wording, or TypeError reading `'prototype'` of undefined,
 * AND a stack frame named `onIframeLoad` / `observeAttachShadow` /
 * `patchAttachShadow`. Never blanket-drop SecurityError or prototype
 * TypeErrors from app code.
 */
const sentryReplayCrossOriginIframeElementMessage =
	/^(?:(?:SecurityError|DOMException):\s*)?Failed to read a named property ['"]Element['"] from ['"]Window['"]:\s*Blocked a frame with origin ["'][^"']+["'] from accessing a cross-origin frame\.?$/i

const sentryReplayCrossOriginIframePrototypeMessage =
	/^(?:TypeError:\s*)?Cannot read propert(?:y|ies) of undefined \(reading ['"]prototype['"]\)$/

const sentryReplayIframeInstrumentationStackFunctions = [
	'onIframeLoad',
	'observeAttachShadow',
	'patchAttachShadow',
] as const

function isSentryReplayCrossOriginIframeElementMessage(message: string) {
	return sentryReplayCrossOriginIframeElementMessage.test(message.trim())
}

function isSentryReplayCrossOriginIframePrototypeMessage(message: string) {
	return sentryReplayCrossOriginIframePrototypeMessage.test(message.trim())
}

function isSentryReplayIframeInstrumentationStackFunction(name: string) {
	return sentryReplayIframeInstrumentationStackFunctions.some(
		(token) => name === token || name.endsWith(`.${token}`),
	)
}

/**
 * Parse function names out of an `Error.stack` string (V8 `at name (url)` /
 * SpiderMonkey `name@url`). Do not substring-match tokens against full stack
 * text — a URL like `onIframeLoad-helper.js` must not count.
 */
function stackTextMentionsReplayIframeInstrumentation(stack: string) {
	for (const line of stack.split('\n')) {
		const trimmed = line.trim()
		const v8 = /^at\s+([^\s(]+)/.exec(trimmed)
		const spidermonkey = /^([^@\s]+)@/.exec(trimmed)
		const name = v8?.[1] ?? spidermonkey?.[1]
		if (name && isSentryReplayIframeInstrumentationStackFunction(name)) {
			return true
		}
	}
	return false
}

function framesMentionReplayIframeInstrumentation(
	frames: Array<SentryStackFrame> | undefined,
) {
	if (!frames || frames.length === 0) return false
	return frames.some(
		(frame) =>
			typeof frame.function === 'string' &&
			isSentryReplayIframeInstrumentationStackFunction(frame.function),
	)
}

function isSentryReplayCrossOriginIframeElementType(type: string | undefined) {
	return (
		type === undefined || type === 'SecurityError' || type === 'DOMException'
	)
}

function isSentryReplayCrossOriginIframePrototypeType(
	type: string | undefined,
) {
	return type === undefined || type === 'TypeError'
}

function isSentryReplayCrossOriginIframeTypedMessage(
	type: string | undefined,
	message: string,
) {
	if (
		isSentryReplayCrossOriginIframeElementType(type) &&
		isSentryReplayCrossOriginIframeElementMessage(message)
	) {
		return true
	}
	return (
		isSentryReplayCrossOriginIframePrototypeType(type) &&
		isSentryReplayCrossOriginIframePrototypeMessage(message)
	)
}

function isSentryReplayCrossOriginIframeError(error: unknown) {
	if (typeof error === 'string') {
		return (
			isSentryReplayCrossOriginIframeElementMessage(error) ||
			isSentryReplayCrossOriginIframePrototypeMessage(error)
		)
	}
	if (typeof error !== 'object' || error === null) return false
	const name =
		'name' in error && typeof error.name === 'string' ? error.name : undefined
	const message =
		'message' in error && typeof error.message === 'string'
			? error.message
			: undefined
	if (!message) return false
	if (!isSentryReplayCrossOriginIframeTypedMessage(name, message)) return false
	const stack =
		'stack' in error && typeof error.stack === 'string' ? error.stack : null
	return stack ? stackTextMentionsReplayIframeInstrumentation(stack) : false
}

/**
 * Drop only when type + message agree on the same exception.values entry
 * (or on originalException / bare event.message when values are absent) and
 * that same entry's frames name Replay iframe instrumentation. Never pair a
 * matching message from one value with an instrumentation frame from another.
 */
function isSentryReplayCrossOriginIframeSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	if (isSentryReplayCrossOriginIframeError(originalException)) return true

	const values = event.exception?.values ?? []
	if (values.length > 0) {
		return values.some((value) => {
			if (typeof value.value !== 'string') return false
			if (
				!isSentryReplayCrossOriginIframeTypedMessage(value.type, value.value)
			) {
				return false
			}
			return framesMentionReplayIframeInstrumentation(value.stacktrace?.frames)
		})
	}

	if (typeof event.message !== 'string') return false
	if (
		!isSentryReplayCrossOriginIframeElementMessage(event.message) &&
		!isSentryReplayCrossOriginIframePrototypeMessage(event.message)
	) {
		return false
	}
	return sentryEventStackFrameFunctions(event).some(
		isSentryReplayIframeInstrumentationStackFunction,
	)
}

function filterSentryReplayCrossOriginIframeSentryEvent<
	T extends SentryErrorEventLike,
>(event: T, originalException?: unknown): T | null {
	if (isSentryReplayCrossOriginIframeSentryEvent(event, originalException)) {
		return null
	}
	return event
}

/**
 * Browser extensions (and other page-injected scripts) that call `eval` /
 * `new Function` in page context trip our CSP: `script-src` intentionally
 * omits `'unsafe-eval'` (see `security-headers.ts`). Chromium surfaces the
 * block as an unhandled `EvalError`. Signature from production issue
 * 7783818887 / KODY-8Y on `/signup` — mechanism
 * `auto.browser.global_handlers.onunhandledrejection`; stack is exclusively
 * `<anonymous>` frames plus Sentry's `sentryWrapped` helper in
 * `@sentry/browser/…/helpers.js` (inApp false), with a frame function named
 * `eval`. Breadcrumbs showed Backpack wallet extension chatter every 5s.
 * First-party client code does not use `eval` / `new Function`.
 *
 * Match is intentionally narrow: EvalError (or the CSP `'unsafe-eval'`
 * refusal wording) on the **same** exception value AND that value's stack
 * frames are each either `<anonymous>` / native or a Sentry SDK frame
 * (`@sentry/` path / `sentryWrapped`), with at least one frame function
 * named `eval` or anonymous-only frames. Type, message, and frames must
 * agree on one `exception.values` entry — never pair a CSP message from
 * one value with an `eval` frame from another (same-entry gate as KODY-8W).
 * Multi-value events drop only when **every** value fully matches; an
 * unrelated sibling keeps the event. Keep when any non-`sentryWrapped`
 * first-party `kody.codes/assets/…` frame is present (`sentryWrapped` may
 * itself be bundled under `/assets/…` in production beforeSend), and keep
 * when the stack is missing or URL-less in a way that could be first-party
 * (same pitfall as KODY-8A). Never blanket-drop EvalError.
 */
const cspUnsafeEvalRefusalMessage =
	/^(?:EvalError:\s*)?Refused to evaluate a string as JavaScript because ['"]unsafe-eval['"] is not an allowed source of script in the following Content Security Policy directive:/i

function isCspUnsafeEvalRefusalMessage(message: string) {
	return cspUnsafeEvalRefusalMessage.test(message.trim())
}

function isEvalErrorName(name: string | undefined) {
	return name === 'EvalError'
}

function isSentrySdkStackFrameUrl(url: string) {
	const normalized = url.replace(/\\/g, '/')
	return (
		normalized.includes('/@sentry/') ||
		normalized.includes('/node_modules/@sentry/') ||
		// Minified / CDN paths sometimes keep the package segment without a
		// leading slash (e.g. `…npm/esm/prod/helpers.js` still carries `@sentry`).
		normalized.includes('@sentry/')
	)
}

function isFirstPartyKodyAssetStackFrameUrl(url: string) {
	try {
		const parsed = new URL(url, 'https://sentry.invalid')
		const host = parsed.hostname
		if (host !== 'kody.codes' && !host.endsWith('.kody.codes')) {
			return false
		}
		return parsed.pathname.includes('/assets/')
	} catch {
		return /(?:^|[/.])kody\.codes\/assets\//i.test(url.replace(/\\/g, '/'))
	}
}

function isAnonymousNativeOrSentrySdkStackFrameUrl(url: string) {
	return isAnonymousOrNativeStackFrameUrl(url) || isSentrySdkStackFrameUrl(url)
}

/**
 * Drop-safe only when every reported frame is present and is either
 * anonymous/native or a Sentry SDK frame (`@sentry/` / `sentryWrapped`),
 * with an `eval` function or anonymous-only URLs. `sentryWrapped` is allowed
 * even when the URL is a bundled `/assets/…` path — production `beforeSend`
 * sees those minified asset URLs, not sourcemapped `@sentry/browser` paths.
 * Other `/assets/…` frames still keep the event. URL-less frames are unknown
 * (possibly first-party) and keep the event.
 */
function isAnonymousOrSentryOnlyReportedFrames(
	frames: Array<SentryStackFrame> | undefined,
) {
	if (!frames || frames.length === 0) return false

	let hasEvalFunction = false
	let allFrameUrlsAnonymousOrNative = true

	for (const frame of frames) {
		// Whitespace-only URLs are unknown provenance (same as URL-less) —
		// keep the event rather than treating trim-empty as anonymous.
		const urls = stackFrameUrls(frame).filter((url) => url.trim().length > 0)
		if (urls.length === 0) return false
		// Bundled Sentry helpers land under /assets/… in production beforeSend
		// (KODY-8A pitfall). Recognize them by function name before treating
		// the URL as a first-party keep signal.
		const isSentryWrapped = frame.function === 'sentryWrapped'
		if (!isSentryWrapped && urls.some(isFirstPartyKodyAssetStackFrameUrl)) {
			return false
		}
		if (
			!isSentryWrapped &&
			!urls.every(isAnonymousNativeOrSentrySdkStackFrameUrl)
		) {
			return false
		}
		if (!urls.every(isAnonymousOrNativeStackFrameUrl)) {
			allFrameUrlsAnonymousOrNative = false
		}
		if (frame.function === 'eval') {
			hasEvalFunction = true
		}
	}

	return hasEvalFunction || allFrameUrlsAnonymousOrNative
}

function exceptionValueIsCspUnsafeEvalRefusal(value: SentryExceptionValue) {
	if (typeof value.value !== 'string') return false
	if (!isCspUnsafeEvalRefusalMessage(value.value)) return false
	if (value.type !== undefined && !isEvalErrorName(value.type)) return false
	return isAnonymousOrSentryOnlyReportedFrames(value.stacktrace?.frames)
}

function isCspUnsafeEvalRefusalError(error: unknown) {
	if (typeof error === 'string') {
		return isCspUnsafeEvalRefusalMessage(error)
	}
	if (typeof error !== 'object' || error === null) return false
	const name =
		'name' in error && typeof error.name === 'string' ? error.name : undefined
	const message =
		'message' in error && typeof error.message === 'string'
			? error.message
			: undefined
	if (!message || !isCspUnsafeEvalRefusalMessage(message)) return false
	// Prefer EvalError when a name is present; bare string messages already
	// matched above. Non-EvalError names with this wording are still CSP
	// refusal (Chromium always uses EvalError, but tolerate missing name).
	if (name && !isEvalErrorName(name)) return false
	return true
}

/**
 * Drop only when type + message + frames agree on the same exception.values
 * entry (and every sibling value also fully matches). Never pair a CSP
 * message from one value with frames from another. originalException /
 * bare event.message alone cannot borrow frames from an unrelated value.
 */
function isCspUnsafeEvalRefusalSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	const values = event.exception?.values ?? []
	if (values.length > 0) {
		return values.every(exceptionValueIsCspUnsafeEvalRefusal)
	}

	// No structured exception values: originalException / event.message
	// without frames stay visible (could be first-party).
	if (isCspUnsafeEvalRefusalError(originalException)) return false
	if (
		typeof event.message === 'string' &&
		isCspUnsafeEvalRefusalMessage(event.message)
	) {
		return false
	}
	return false
}

function filterCspUnsafeEvalRefusalSentryEvent<T extends SentryErrorEventLike>(
	event: T,
	originalException?: unknown,
): T | null {
	if (isCspUnsafeEvalRefusalSentryEvent(event, originalException)) {
		return null
	}
	return event
}

/**
 * Drop CrabApple's failed hard-spoof of `navigator.userAgent`. An injected
 * script labeled CrabApple redefines that property; modern Safari throws
 * `TypeError: Cannot redefine property: userAgent`, and the script wraps it
 * as `[CrabApple] Failed to hard-spoof navigator.userAgent`. The event
 * reaches Sentry from anonymous / `spoofBrowserAndPlatform` frames on the
 * host page (production issue 7746637649 / KODY-80, Safari 17.4 on
 * https://kody.codes/). There are no chrome-extension frames on this event.
 *
 * Drop when the exception value or originalException message includes
 * `[CrabApple]` and either `hard-spoof navigator.userAgent` or
 * `Cannot redefine property: userAgent`. Keep the same TypeError when the
 * CrabApple marker is absent.
 */
function isCrabAppleUserAgentSpoofMessage(message: string) {
	if (!message.includes('[CrabApple]')) return false
	return (
		message.includes('hard-spoof navigator.userAgent') ||
		message.includes('Cannot redefine property: userAgent')
	)
}

function isCrabAppleUserAgentSpoofError(error: unknown) {
	if (typeof error === 'string') {
		return isCrabAppleUserAgentSpoofMessage(error)
	}
	if (typeof error !== 'object' || error === null) return false
	if (!('message' in error) || typeof error.message !== 'string') return false
	return isCrabAppleUserAgentSpoofMessage(error.message)
}

function isCrabAppleUserAgentSpoofSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	if (isCrabAppleUserAgentSpoofError(originalException)) return true
	return sentryEventMessages(event).some(
		(message) =>
			typeof message === 'string' && isCrabAppleUserAgentSpoofMessage(message),
	)
}

function filterCrabAppleUserAgentSpoofSentryEvent<
	T extends SentryErrorEventLike,
>(event: T, originalException?: unknown): T | null {
	if (isCrabAppleUserAgentSpoofSentryEvent(event, originalException)) {
		return null
	}
	return event
}

/** Combined browser beforeSend / capture gate used by the client SDK. */
export function filterBrowserSentryEvent<T extends SentryErrorEventLike>(
	event: T,
	originalException?: unknown,
): T | null {
	if (filterBrowserAbortSentryEvent(event, originalException) === null) {
		return null
	}
	if (
		filterFirefoxDomPermissionDeniedSentryEvent(event, originalException) ===
		null
	) {
		return null
	}
	if (
		filterBrowserInjectedGlobalNoiseSentryEvent(event, originalException) ===
		null
	) {
		return null
	}
	if (filterFathomRemoveChildNullSentryEvent(event) === null) {
		return null
	}
	if (
		filterChromeExtensionObjectNotFoundSentryEvent(event, originalException) ===
		null
	) {
		return null
	}
	if (
		filterChromeExtensionReceivingEndMissingSentryEvent(
			event,
			originalException,
		) === null
	) {
		return null
	}
	if (
		filterChromeExtensionSendMessageTabNotFoundSentryEvent(
			event,
			originalException,
		) === null
	) {
		return null
	}
	if (filterMetaMaskExtensionSentryEvent(event, originalException) === null) {
		return null
	}
	if (
		filterMetaMaskWalletNoAccountSentryEvent(event, originalException) === null
	) {
		return null
	}
	if (
		filterChromeExtensionMessageChannelDisconnectedSentryEvent(
			event,
			originalException,
		) === null
	) {
		return null
	}
	if (
		filterChromeExtensionClientDestroyedSentryEvent(
			event,
			originalException,
		) === null
	) {
		return null
	}
	if (
		filterChromeExtensionCallStackExceededSentryEvent(
			event,
			originalException,
		) === null
	) {
		return null
	}
	if (
		filterChromeExtensionUndefinedMIdSentryEvent(event, originalException) ===
		null
	) {
		return null
	}
	if (
		filterTwitterInAppBrowserConfigSentryEvent(event, originalException) ===
		null
	) {
		return null
	}
	if (
		filterTwitterInAppBrowserWebkitMessageHandlersSentryEvent(
			event,
			originalException,
		) === null
	) {
		return null
	}
	if (
		filterOgTypeMetaQuerySelectorContentSentryEvent(
			event,
			originalException,
		) === null
	) {
		return null
	}
	if (
		filterBrowserBlobImportScriptsNetworkSentryEvent(
			event,
			originalException,
		) === null
	) {
		return null
	}
	if (filterUnknownStartReleaseSentryEvent(event, originalException) === null) {
		return null
	}
	if (
		filterTanStackServerFnFetchNetworkSentryEvent(event, originalException) ===
		null
	) {
		return null
	}
	if (
		filterSyntaxHighlightCoreDynamicImportFailureSentryEvent(
			event,
			originalException,
		) === null
	) {
		return null
	}

	if (filterLocalViteDevSentryEvent(event, originalException) === null) {
		return null
	}
	if (
		filterCloudflareTurnstileClientSentryEvent(event, originalException) ===
		null
	) {
		return null
	}

	if (
		filterCrabAppleUserAgentSpoofSentryEvent(event, originalException) === null
	) {
		return null
	}
	if (
		filterCspUnsafeEvalRefusalSentryEvent(event, originalException) === null
	) {
		return null
	}
	if (
		filterSentryReplayCrossOriginIframeSentryEvent(event, originalException) ===
		null
	) {
		return null
	}
	return event
}
