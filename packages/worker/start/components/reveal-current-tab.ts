type TabRow = Pick<HTMLElement, 'clientWidth' | 'scrollLeft' | 'querySelector'>

/**
 * Keeps the current tab in view when an underline tab row scrolls sideways on
 * narrow screens. Only the row scrolls; the page never jumps. Use as the
 * row's ref; the row must be the tabs' offset parent.
 */
export function revealCurrentTab(nav: TabRow | null) {
	const current = nav?.querySelector<HTMLElement>('[aria-current="page"]')
	if (!nav || !current) return
	const overflow = current.offsetLeft + current.offsetWidth - nav.clientWidth
	if (overflow > 0) nav.scrollLeft = overflow + current.offsetWidth / 2
}
