import { expect, test } from 'vitest'
import {
	formatSearchAppStartersMarkdown,
	isAppCreationSearchQuery,
} from './search-app-starters.ts'

test('app creation queries are recognized', () => {
	expect(isAppCreationSearchQuery('make me a habit tracker app')).toBe(true)
	expect(isAppCreationSearchQuery('build a dashboard')).toBe(true)
	expect(isAppCreationSearchQuery('open my notes app')).toBe(false)
	expect(isAppCreationSearchQuery('create a reminder')).toBe(false)
})

test('the section lists starters in order with the fork call', () => {
	const starter = {
		name: 'App starter',
		description: 'A basic app.',
		whenToUse: 'Most new apps.',
		tags: ['app'],
		preview: 'public/starter-preview.png',
		capabilities: ['sign-in'],
		customize: { themeTokens: 'a.css', routes: 'r', content: 'c' },
	}
	const markdown = formatSearchAppStartersMarkdown([
		{
			packageId: 'pkg-1',
			packageName: '@kody/app-starter',
			rank: 1,
			enabled: true,
			note: null,
			updatedAt: '',
			listingId: 'listing-1',
			starter,
			checks: [],
			problems: [],
		},
	])
	expect(markdown).toContain('## Making an app')
	expect(markdown).toContain('guide:making_great_apps')
	expect(markdown).toContain('`@kody/app-starter`')
	expect(markdown).toContain('communityFork({ listing_id: "listing-1" })')
})

test('the guide pointer shows even before any starter is listed', () => {
	expect(formatSearchAppStartersMarkdown([])).toContain(
		'guide:making_great_apps',
	)
})
