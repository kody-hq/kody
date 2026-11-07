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
				const start = Number.parseFloat(
					style.getPropertyValue('--tw-fade-opacity-l'),
				)
				const end = Number.parseFloat(
					style.getPropertyValue('--tw-fade-opacity-r'),
				)
				return {
					scrollLeft: node.scrollLeft,
					startOn: start > 0,
					endOn: end > 0,
				}
			}),
		)
		.toEqual({ scrollLeft: 0, startOn: true, endOn: true })
})
