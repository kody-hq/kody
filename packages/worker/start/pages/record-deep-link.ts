/**
 * A list/detail URL opened as a document (first load or a hard reload)
 * scrolls its selected record into view and flashes it once. Row clicks and
 * other client navigation never scroll: the first committed client
 * navigation marks the document with `data-spa-nav` and ends the chance.
 */
export function createDeepLinkFocus() {
	let pending = true
	return function claim(input: { spaNavigated: boolean; hasTarget: boolean }) {
		if (!pending) return false
		if (input.spaNavigated) {
			pending = false
			return false
		}
		if (!input.hasTarget) return false
		pending = false
		return true
	}
}

export const documentDeepLinkFocus = createDeepLinkFocus()

export const recordHighlightMs = 1600

/** Scroll after the router's own scroll restoration has run. */
export function revealDeepLinkedRecord(
	target: HTMLElement,
	win: Pick<
		Window,
		'matchMedia' | 'requestAnimationFrame' | 'setTimeout'
	> = window,
) {
	const reduceMotion = win.matchMedia(
		'(prefers-reduced-motion: reduce)',
	).matches
	target.setAttribute('data-record-highlight', 'true')
	win.setTimeout(
		() => target.removeAttribute('data-record-highlight'),
		recordHighlightMs,
	)
	win.requestAnimationFrame(() =>
		win.requestAnimationFrame(() =>
			target.scrollIntoView({
				block: 'start',
				behavior: reduceMotion ? 'auto' : 'smooth',
			}),
		),
	)
}
