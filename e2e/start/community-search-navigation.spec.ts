import { expect, test, waitForClientHydration } from '../playwright-utils.ts'

test('community search submit filters in place and shows the no-match state', async ({
	page,
}) => {
	await page.goto('/community')
	await waitForClientHydration(page)
	const search = page.getByRole('searchbox', { name: 'Search public packages' })
	await search.fill('photofklsdafj')
	await page.getByRole('button', { name: 'Search', exact: true }).click()
	await expect(page).toHaveURL(
		(url) => url.searchParams.get('q') === 'photofklsdafj',
	)
	// Client navigation must read the new query, not keep the first match's
	// unfiltered browse input.
	await expect(
		page.getByRole('heading', { name: 'Nothing matched that search.' }),
	).toBeVisible()
	await expect(page.getByTestId('community-listings-overview')).toHaveCount(0)
	await expect(search).toHaveValue('photofklsdafj')

	await page.getByRole('link', { name: 'Clear search' }).click()
	await expect(page).toHaveURL((url) => !url.searchParams.has('q'))
	await expect(
		page.getByRole('heading', { name: 'Nothing matched that search.' }),
	).toHaveCount(0)
})
