import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { expect, test } from 'vitest'
import { colors } from '#universal/styles/tokens.ts'
import type { SatoriChild, SatoriElement } from '#worker/og/render.ts'
import { renderCommunityIconFallbackPng } from './community-icon.ts'
import { createCommunityOgMarkup, renderCommunityOgImage } from './og-image.ts'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const

function expectPngBytes(png: Uint8Array) {
	expect(png.byteLength).toBeGreaterThan(10_000)
	for (const [index, byte] of PNG_MAGIC.entries()) {
		expect(png[index]).toBe(byte)
	}
}

async function sampleIconDataUri(name: string) {
	const png = await renderCommunityIconFallbackPng(name)
	return `data:image/png;base64,${bytesToBase64(png)}`
}

function walkSatori(
	node: SatoriChild | Array<SatoriChild> | undefined,
	visit: (element: SatoriElement) => void,
) {
	if (node == null) return
	if (typeof node === 'string') return
	if (Array.isArray(node)) {
		for (const child of node) walkSatori(child, visit)
		return
	}
	visit(node)
	walkSatori(node.props.children, visit)
}

function findPackageIconWell(markup: SatoriElement) {
	const wells: Array<SatoriElement> = []
	walkSatori(markup, (element) => {
		if (element.props.style?.backgroundColor === colors.logoWell) {
			wells.push(element)
		}
	})
	expect(wells).toHaveLength(1)
	return wells[0]!
}

test('renderCommunityOgImage returns valid PNG bytes with and without ratings', async () => {
	expect.hasAssertions()
	const withRatings = await renderCommunityOgImage({
		name: '@kody/github-triage',
		description:
			'automatically triage new GitHub issues with labels, assignees, and a friendly first response for your open-source repos',
		ownerUsername: 'kody',
		averageStars: 4.6,
		ratingCount: 12,
		forkCount: 37,
		iconDataUri: await sampleIconDataUri('@kody/github-triage'),
	})
	expectPngBytes(withRatings)

	const withoutRatingsInput = {
		name: '@kody/new-package',
		description: 'summarize your inbox every morning',
		ownerUsername: 'jane',
		averageStars: null,
		ratingCount: 0,
		forkCount: 2,
		iconDataUri: await sampleIconDataUri('@kody/new-package'),
	}
	const withoutRatings = await renderCommunityOgImage(withoutRatingsInput)
	expectPngBytes(withoutRatings)

	for (const theme of ['dark', 'light'] as const) {
		const well = findPackageIconWell(
			createCommunityOgMarkup({ ...withoutRatingsInput, theme }),
		)
		expect(well.props.style).toMatchObject({
			backgroundColor: colors.logoWell,
			overflow: 'hidden',
		})
		expect(well.props.style?.backgroundColor).toBe('#ffffff')
	}
})
