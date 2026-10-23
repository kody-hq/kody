import { expect, test, vi } from 'vitest'
import { dismissOpenPopoverPanel, isPopoverOpen } from './popover-open.ts'

test('isPopoverOpen returns false when matches throws for :popover-open', () => {
	const throwingMatches = vi.fn(() => {
		throw new SyntaxError('The string did not match the expected pattern.')
	})
	const panel = { matches: throwingMatches } as unknown as HTMLElement
	expect(isPopoverOpen(panel)).toBe(false)
	expect(throwingMatches).toHaveBeenCalledWith(':popover-open')
	expect(isPopoverOpen(null)).toBe(false)
})

test('dismissOpenPopoverPanel hides open popovers and no-ops when unavailable or closed', () => {
	const unavailableMatches = vi.fn(() => {
		throw new SyntaxError(
			"Failed to execute 'matches' on 'Element': ':popover-open' is not a valid selector.",
		)
	})
	const unavailablePanel = {
		matches: unavailableMatches,
	} as unknown as HTMLElement
	expect(() => dismissOpenPopoverPanel(unavailablePanel)).not.toThrow()
	expect(unavailableMatches).not.toHaveBeenCalled()

	const hidePopover = vi.fn()
	const openPanel = {
		hidePopover,
		matches: vi.fn((selector: string) => selector === ':popover-open'),
	} as unknown as HTMLElement
	dismissOpenPopoverPanel(openPanel)
	expect(openPanel.matches).toHaveBeenCalledWith(':popover-open')
	expect(hidePopover).toHaveBeenCalledOnce()

	const closedHidePopover = vi.fn()
	const closedPanel = {
		hidePopover: closedHidePopover,
		matches: vi.fn(() => false),
	} as unknown as HTMLElement
	dismissOpenPopoverPanel(closedPanel)
	expect(closedHidePopover).not.toHaveBeenCalled()

	// Safari 16: hidePopover may exist as a no-op polyfill or stub while
	// matches(':popover-open') still throws SyntaxError.
	const throwingHide = vi.fn()
	const throwingMatches = vi.fn(() => {
		throw new SyntaxError('The string did not match the expected pattern.')
	})
	const throwingPanel = {
		hidePopover: throwingHide,
		matches: throwingMatches,
	} as unknown as HTMLElement
	expect(() => dismissOpenPopoverPanel(throwingPanel)).not.toThrow()
	expect(throwingMatches).toHaveBeenCalledWith(':popover-open')
	expect(throwingHide).not.toHaveBeenCalled()
})
