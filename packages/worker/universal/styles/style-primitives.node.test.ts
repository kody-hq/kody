import { expect, test } from 'vitest'
import { getButtonCss } from './style-primitives.ts'

test('filled buttons use the same display font as ghost pills', () => {
	expect(getButtonCss({ variant: 'secondary', size: 'lg' }).font).toContain('var(--font-display)')
	for (const css of [
		getButtonCss({ variant: 'primary', size: 'md' }),
		getButtonCss({ variant: 'secondary', size: 'md' }),
		getButtonCss({ variant: 'danger', size: 'md' }),
	]) {
		expect(css.fontFamily).toBe('var(--font-display)')
	}
})
