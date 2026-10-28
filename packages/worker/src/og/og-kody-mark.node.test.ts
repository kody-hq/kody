import { expect, test } from 'vitest'
import { getKodyMarkDataUri } from './og-image-assets.node.ts'
import { getOgPalette, type OgTheme } from './palette.ts'

function decodeMark(theme: OgTheme): string {
	const dataUri = getKodyMarkDataUri(theme)
	const prefix = 'data:image/svg+xml;base64,'
	expect(dataUri.startsWith(prefix)).toBe(true)
	return Buffer.from(dataUri.slice(prefix.length), 'base64').toString('utf8')
}

test('the OG header mark is inked in the card text colour for every theme', () => {
	for (const theme of ['dark', 'light'] as const) {
		const svg = decodeMark(theme)
		const fills = [...svg.matchAll(/fill="([^"]*)"/gi)].map((match) => match[1])
		expect(fills.length).toBeGreaterThan(0)
		expect(new Set(fills)).toEqual(new Set([getOgPalette(theme).text]))
	}
	// Dark cards get the solid mark, light cards the outlined line art.
	expect(decodeMark('dark')).not.toBe(decodeMark('light'))
})
