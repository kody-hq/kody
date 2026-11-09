import { expect, test } from 'vitest'
import {
	getDangerButtonCss,
	getGhostButtonCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
} from './style-primitives.ts'

test('filled buttons use the same display font as ghost pills', () => {
	expect(getGhostButtonCss().font).toContain('var(--font-display)')
	for (const css of [
		getPrimaryButtonCss(),
		getSecondaryButtonCss(),
		getDangerButtonCss(),
	]) {
		expect(css.fontFamily).toBe('var(--font-display)')
	}
})
