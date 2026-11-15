import { expect, test } from 'vitest'
import {
	getButtonCss,
	renderButtonStylesheet,
	type ButtonSize,
	type ButtonVariant,
} from './style-primitives.ts'

const variants: Array<ButtonVariant> = [
	'primary',
	'secondary',
	'ghost',
	'danger',
]
const sizes: Array<ButtonSize> = ['xs', 'sm', 'md', 'lg']

test('every button variant and size gets squircle corners, never a pill', () => {
	for (const variant of variants) {
		for (const size of sizes) {
			for (const iconOnly of [false, true]) {
				const css = getButtonCss({ variant, size, iconOnly })
				expect(css.borderRadius).toMatch(/^0\.\d+rem$/)
				expect(css['@supports (corner-shape: squircle)']).toMatchObject({
					cornerShape: 'squircle',
				})
				expect(JSON.stringify(css)).not.toMatch(/999px|radius-full/)
			}
		}
	}
})

test('primary and secondary share one shape so a row of actions matches', () => {
	const primary = getButtonCss({ variant: 'primary', size: 'lg' })
	const secondary = getButtonCss({ variant: 'secondary', size: 'lg' })
	expect(primary.borderRadius).toBe(secondary.borderRadius)
	expect(primary.font).toBe(secondary.font)
	expect(primary.font).toContain('var(--font-display)')
})

test('static pages render the same squircle button stylesheet', () => {
	const sheet = renderButtonStylesheet({
		'a.go': { variant: 'primary', size: 'lg' },
	})
	expect(sheet).toContain('a.go{')
	expect(sheet).toContain('border-radius:0.625rem')
	expect(sheet).toContain(
		'@supports (corner-shape: squircle){a.go{border-radius:1.125rem;corner-shape:squircle}}',
	)
	expect(sheet).toContain('a.go:disabled,a.go[aria-disabled="true"]{')
	expect(sheet).not.toContain('999px')
})
