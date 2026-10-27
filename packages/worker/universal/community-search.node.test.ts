import { expect, test } from 'vitest'
import {
	buildCommunityIndexHref,
	parseCommunityListingSort,
	readCommunitySearchFromHref,
	withInstallOrg,
} from './community-search.ts'

test('community search hrefs omit default sort and keep newest with the query', () => {
	expect(parseCommunityListingSort(null)).toBe('best')
	expect(parseCommunityListingSort('best')).toBe('best')
	expect(parseCommunityListingSort('bogus')).toBe('best')
	expect(parseCommunityListingSort('newest')).toBe('newest')

	expect(buildCommunityIndexHref()).toBe('/community')
	expect(buildCommunityIndexHref({ sort: 'best' })).toBe('/community')
	expect(buildCommunityIndexHref({ query: '  github  ' })).toBe(
		'/community?q=github',
	)
	expect(buildCommunityIndexHref({ query: 'github', sort: 'newest' })).toBe(
		'/community?q=github&sort=newest',
	)
	expect(buildCommunityIndexHref({ sort: 'newest' })).toBe(
		'/community?sort=newest',
	)

	expect(
		readCommunitySearchFromHref('/community?q=obsidian&sort=newest'),
	).toEqual({
		query: 'obsidian',
		sort: 'newest',
		category: null,
	})
	expect(
		buildCommunityIndexHref({
			query: 'github',
			sort: 'newest',
			category: 'integrations',
		}),
	).toBe('/community?q=github&sort=newest&category=integrations')
	expect(
		readCommunitySearchFromHref(
			'/community?q=github&sort=newest&category=integrations',
		),
	).toEqual({
		query: 'github',
		sort: 'newest',
		category: 'integrations',
	})
})

test('withInstallOrg keeps the picked org on site-relative hrefs', () => {
	expect(withInstallOrg('/@sample-author/weather-widget', null)).toBe(
		'/@sample-author/weather-widget',
	)
	expect(
		withInstallOrg(
			'/@sample-author/weather-widget/tree/main/a.ts',
			'example-team',
		),
	).toBe('/@sample-author/weather-widget/tree/main/a.ts?org=example-team')
	expect(withInstallOrg('/community?q=weather#top', 'example-team')).toBe(
		'/community?q=weather&org=example-team#top',
	)
})
