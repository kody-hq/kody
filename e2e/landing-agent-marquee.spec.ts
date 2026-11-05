import { expect, test } from './playwright-utils.ts'

// The marquee drifts with a CSS transform and never scrolls, so tw-fade's
// scroll-driven start fade would stay off unless both edges are pinned on.
test('landing agent marquee fades both edges while it drifts', async ({
	page,
}) => {
	await page.goto('/')
	const marquee = page.getByRole('navigation', {
		name: 'Agents that work with Kody',
	})
	await expect(marquee).toBeVisible()
	await expect
		.poll(() =>
			marquee.evaluate((node) => {
				const style = getComputedStyle(node)
				return {
					scrollLeft: node.scrollLeft,
					start: style.getPropertyValue('--tw-fade-opacity-l').trim(),
					end: style.getPropertyValue('--tw-fade-opacity-r').trim(),
				}
			}),
		)
		.toEqual({ scrollLeft: 0, start: '1', end: '1' })
})
