import { expect, test } from 'vitest'
import {
	getDangerButtonCss,
	getGhostButtonCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
} from './style-primitives.ts'
import { typography } from './tokens.ts'

test('filled buttons use the same display font as ghost pills', () => {
	expect(getGhostButtonCss().font).toContain(typography.fontFamilyDisplay)
	for (const css of [
		getPrimaryButtonCss(),
		getSecondaryButtonCss(),
		getDangerButtonCss(),
	]) {
		expect(css.fontFamily).toBe(typography.fontFamilyDisplay)
	}
})
