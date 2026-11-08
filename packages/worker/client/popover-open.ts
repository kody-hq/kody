/**
 * Whether a popover panel is open. Older browsers throw from
 * `matches(':popover-open')` when the Popover API is unavailable (Safari < 17).
 */
export function isPopoverOpen(element: Element | null): boolean {
	if (!element) return false
	try {
		return element.matches(':popover-open')
	} catch {
		return false
	}
}

/**
 * Dismiss an open popover panel on client-side navigation. Older browsers
 * throw from `matches(':popover-open')` when the Popover API is unavailable.
 */
export function dismissOpenPopoverPanel(panel: Element | null) {
	if (!panel || typeof (panel as HTMLElement).hidePopover !== 'function') return
	const element = panel as HTMLElement
	if (isPopoverOpen(element)) {
		element.hidePopover()
	}
}

/**
 * Show a popover panel. Older browsers lack `showPopover` when the Popover API
 * is unavailable (Chrome < 114, Safari < 17), so this no-ops there.
 */
export function showPopoverPanel(panel: Element | null) {
	if (!panel || typeof (panel as HTMLElement).showPopover !== 'function') return
	const element = panel as HTMLElement
	element.showPopover()
}
