import { expect, test } from 'vitest'
import { renderCommunityIconFallbackPng } from './community-icon.ts'
import { buildCommunityIconFallbackSvg } from './community-icon-fallback.ts'

test('package-name fallbacks are distinct', async () => {
	const friction = buildCommunityIconFallbackSvg('@kentcdodds/friction-log')
	expect(friction).not.toBe(
		buildCommunityIconFallbackSvg('@kentcdodds/github-tools'),
	)

	const frictionPng = await renderCommunityIconFallbackPng(
		'@kentcdodds/friction-log',
	)
	const toolsPng = await renderCommunityIconFallbackPng(
		'@kentcdodds/github-tools',
	)
	expect(frictionPng).not.toEqual(toolsPng)
})
