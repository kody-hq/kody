import {
	emptyPublicFormProtection,
	honeypotFieldName,
	turnstileResponseFieldName,
	type PublicFormProtectionFields,
} from '#universal/public-form-protection.ts'

export {
	emptyPublicFormProtection,
	honeypotFieldName,
	turnstileResponseFieldName,
	type PublicFormProtectionFields,
}

export const turnstileWidgetClassName = 'kody-turnstile'

/**
 * Cloudflare's managed widget box. Keep `.kody-turnstile` in
 * `packages/worker/public/styles.css` in sync with these values.
 */
const turnstileWidgetWidthPx = 300
const turnstileWidgetHeightPx = 65

type TurnstileApi = {
	render(
		container: HTMLElement,
		options: {
			sitekey: string
			'response-field-name': string
			/**
			 * Returning a non-falsy value tells Turnstile the error was handled so
			 * it does not escalate to console / window listeners that Sentry
			 * captures as TurnstileError (KODY-6E).
			 */
			'error-callback'?: (errorCode: string | number) => boolean | void
		},
	): string
	reset?(container: HTMLElement | string): void
	remove?(container: HTMLElement | string): void
	getResponse?(widgetId: string): string | undefined
}

let turnstileScriptPromise: Promise<TurnstileApi> | null = null

function getTurnstileApi() {
	return (window as typeof window & { turnstile?: TurnstileApi }).turnstile
}

/**
 * Exact messages thrown when challenges.cloudflare.com is blocked (ad
 * blocker / privacy extension / network) or the script loads without
 * exposing `window.turnstile`. Matched by browser Sentry filters (KODY-6D).
 */
const turnstileScriptFailedToLoadMessage = 'Turnstile script failed to load.'
const turnstileApiDidNotInitializeMessage = 'Turnstile API did not initialize.'

function loadTurnstileScript() {
	const existingApi = getTurnstileApi()
	if (existingApi) return Promise.resolve(existingApi)
	if (turnstileScriptPromise) return turnstileScriptPromise

	turnstileScriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
		const existingScript = document.querySelector<HTMLScriptElement>(
			'script[data-kody-turnstile]',
		)
		const script = existingScript ?? document.createElement('script')
		const fail = (message: string) => {
			// Clear so a later render attempt can inject a fresh script tag
			// (one blocked load must not pin the page for the whole session).
			turnstileScriptPromise = null
			if (!existingScript) {
				script.remove()
			}
			reject(new Error(message))
		}
		const handleLoad = () => {
			const api = getTurnstileApi()
			if (api) resolve(api)
			else fail(turnstileApiDidNotInitializeMessage)
		}
		script.addEventListener('load', handleLoad, { once: true })
		script.addEventListener(
			'error',
			() => fail(turnstileScriptFailedToLoadMessage),
			{ once: true },
		)
		if (!existingScript) {
			script.src =
				'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
			script.async = true
			script.defer = true
			script.dataset.kodyTurnstile = 'true'
			document.head.append(script)
		}
	})
	return turnstileScriptPromise
}

/**
 * Keep Turnstile-owned nodes isolated from the form renderer. Check the
 * shadow mount itself before deciding a widget needs to be recreated. Hosts
 * without shadow DOM support use the container itself.
 */
function ensureTurnstileMount(container: HTMLElement) {
	if (!container.shadowRoot && typeof container.attachShadow === 'function') {
		try {
			container.attachShadow({ mode: 'open' })
		} catch {
			// Already attached, or this host cannot take a shadow root.
		}
	}
	const root = container.shadowRoot
	if (!root) {
		return container
	}
	const existing = root.querySelector<HTMLElement>('[data-turnstile-mount]')
	if (existing) {
		return existing
	}
	if (typeof document === 'undefined') {
		return container
	}
	if (!root.querySelector('style[data-turnstile-host]')) {
		const style = document.createElement('style')
		style.dataset.turnstileHost = ''
		style.textContent = `:host{display:block;box-sizing:border-box;flex-shrink:0;height:${turnstileWidgetHeightPx}px;min-height:${turnstileWidgetHeightPx}px;width:min(${turnstileWidgetWidthPx}px,100%)}[data-turnstile-mount]{height:${turnstileWidgetHeightPx}px;min-height:${turnstileWidgetHeightPx}px}`
		root.append(style)
	}
	const mount = document.createElement('div')
	mount.dataset.turnstileMount = ''
	root.append(mount)
	return mount
}

function isTurnstileWidgetAlive(mount: HTMLElement) {
	return mount.childElementCount > 0
}

function clearTurnstileRenderedMarker(container: HTMLElement) {
	delete container.dataset.turnstileRendered
	delete container.dataset.turnstileWidgetId
}

function abandonOrphanedTurnstileWidget(
	api: TurnstileApi,
	container: HTMLElement,
	mount = ensureTurnstileMount(container),
) {
	clearTurnstileRenderedMarker(container)
	try {
		api.remove?.(mount)
	} catch {
		// Widget is already gone from Turnstile's registry; ignore.
	}
}

function readTurnstileResponseFromWidgets(scope?: ParentNode | null) {
	const api = getTurnstileApi()
	if (!api?.getResponse || typeof document === 'undefined') {
		return ''
	}
	const root = scope ?? document
	for (const container of root.querySelectorAll<HTMLElement>(
		`.${turnstileWidgetClassName}`,
	)) {
		const widgetId = container.dataset.turnstileWidgetId
		if (!widgetId) continue
		const response = api.getResponse(widgetId)
		if (typeof response === 'string' && response.length > 0) {
			return response
		}
	}
	return ''
}

/**
 * Turnstile's documented contract: a non-falsy return means the host handled
 * the client error (300* generic challenge failures, iframe load blips, …)
 * so Turnstile skips its default window escalation.
 */
function handleTurnstileWidgetError(_errorCode: string | number) {
	return true
}

export async function renderTurnstileWidgets(siteKey: string | null) {
	if (!siteKey || typeof document === 'undefined') return
	let api: TurnstileApi
	try {
		api = await loadTurnstileScript()
	} catch {
		// Script blocked or CDN blip — expected visitor-environment degradation
		// (KODY-6D). Auth POSTs still surface a server-side protection
		// error if the user submits without a token; do not Sentry-noise this.
		return
	}
	for (const container of document.querySelectorAll<HTMLElement>(
		`.${turnstileWidgetClassName}`,
	)) {
		const mount = ensureTurnstileMount(container)
		if (container.dataset.turnstileRendered === 'true') {
			if (isTurnstileWidgetAlive(mount)) continue
			abandonOrphanedTurnstileWidget(api, container, mount)
		}
		try {
			const widgetId = api.render(mount, {
				sitekey: siteKey,
				'response-field-name': turnstileResponseFieldName,
				'error-callback': handleTurnstileWidgetError,
			})
			container.dataset.turnstileRendered = 'true'
			if (widgetId) {
				container.dataset.turnstileWidgetId = widgetId
			}
		} catch (error) {
			clearTurnstileRenderedMarker(container)
			throw error
		}
	}
}

/**
 * Issue a fresh challenge token. Turnstile tokens are single-use: the server
 * consumes one on every verify, so a form that stays mounted after a failed
 * submit would resubmit a spent token and be rejected for the wrong reason.
 * Call this on any path that leaves the form up for another try.
 *
 * Never throws: a dead/orphaned widget (DOM wiped by a re-render) must not
 * surface as an unhandled rejection from submit handlers. Clear the marker so
 * the next `renderTurnstileWidgets` call can remount.
 */
export function resetTurnstileWidgets() {
	if (typeof document === 'undefined') return
	const api = getTurnstileApi()
	if (!api?.reset) return
	for (const container of document.querySelectorAll<HTMLElement>(
		`.${turnstileWidgetClassName}[data-turnstile-rendered]`,
	)) {
		const mount = ensureTurnstileMount(container)
		if (!isTurnstileWidgetAlive(mount)) {
			abandonOrphanedTurnstileWidget(api, container, mount)
			continue
		}
		try {
			api.reset(mount)
		} catch {
			abandonOrphanedTurnstileWidget(api, container, mount)
		}
	}
}

export function readPublicFormProtection(
	formData: FormData,
	scope?: ParentNode | null,
): PublicFormProtectionFields {
	const fromField = String(formData.get(turnstileResponseFieldName) ?? '')
	return {
		[honeypotFieldName]: String(formData.get(honeypotFieldName) ?? ''),
		[turnstileResponseFieldName]:
			fromField || readTurnstileResponseFromWidgets(scope),
	}
}
