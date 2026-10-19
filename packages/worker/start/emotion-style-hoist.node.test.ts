import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, vi } from 'vitest'

const hoistSource = readFileSync(
	resolve(import.meta.dirname, '../public/emotion-style-hoist.js'),
	'utf8',
)

test('emotion style hoist moves hashed SSR Insertion styles into head', () => {
	const moved: Array<string> = []
	const styles = [
		makeStyle('css abcd12', false),
		makeStyle('css', false),
		makeStyle('css ef456', true),
	]
	const document = {
		querySelectorAll(selector: string) {
			expect(selector).toBe('style[data-emotion]:not([data-s])')
			return styles.filter((style) => !style.hasDataS)
		},
		head: {
			appendChild(el: ReturnType<typeof makeStyle>) {
				moved.push(el.attr)
			},
		},
	}
	vi.stubGlobal('document', document)
	try {
		// Classic IIFE reads global document, same as the browser script.
		new Function(hoistSource)()
	} finally {
		vi.unstubAllGlobals()
	}
	expect(moved).toEqual(['css abcd12'])
	expect(styles[0]!.hasDataS).toBe(true)
	expect(styles[1]!.hasDataS).toBe(false)
})

function makeStyle(attr: string, hasDataS: boolean) {
	return {
		attr,
		hasDataS,
		getAttribute(name: string) {
			if (name === 'data-emotion') return this.attr
			if (name === 'data-s') return this.hasDataS ? '' : null
			return null
		},
		setAttribute(name: string, value: string) {
			if (name === 'data-s') this.hasDataS = value === ''
		},
	}
}
