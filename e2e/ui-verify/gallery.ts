import type { Page } from '../playwright-utils.ts'

/**
 * Show one `/dev/ui` section alone at the top of the gallery, so its baseline
 * does not shift by a sub-pixel when an earlier section changes height.
 * `null` shows the whole gallery again.
 */
export async function isolateGallerySection(page: Page, id: string | null) {
	await page.evaluate((id) => {
		const main = document.querySelector(
			'[data-ui-gallery-section]',
		)?.parentElement
		if (!main) throw new Error('No [data-ui-gallery-section] on this page.')
		for (const child of Array.from(main.children) as Array<HTMLElement>) {
			child.style.display =
				id === null || child.dataset.uiGallerySection === id ? '' : 'none'
		}
		window.scrollTo(0, 0)
	}, id)
}
