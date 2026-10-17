import { expect, test } from 'vitest'
import { communityReadInput, profileReadInput } from './public-read-input.ts'

test('community inputs exclude attribution and normalize query and bounds', () => {
	expect(
		communityReadInput(
			'?q=%20tools%20&sort=popular&category=dev&limit=1000&utm_source=demo',
		),
	).toEqual({ query: 'tools', sort: 'popular', category: 'dev', limit: 100 })
	expect(communityReadInput('?limit=invalid').limit).toBe(50)
})
test('profile filtering remains local until a limit is requested', () => {
	expect(profileReadInput('owner', '?q=tools')).toEqual({
		username: 'owner',
		query: '',
		limit: undefined,
	})
	expect(
		profileReadInput('owner', '?q=%20tools%20&limit=20&view=grid'),
	).toEqual({ username: 'owner', query: 'tools', limit: 20 })
	expect(profileReadInput('owner', '?limit=-1').limit).toBeUndefined()
})
