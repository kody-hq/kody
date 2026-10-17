import { defaultParseSearch } from '@tanstack/react-router'
import { expect, test } from 'vitest'
import { memoriesInput } from './memories-input.ts'

test('memory query keys contain normalized resource filters, not navigation decoration', () => {
	expect(
		memoriesInput(
			'team',
			defaultParseSearch(
				'?q=+meeting+&includeDeleted=YES&selected=one&youtubeId=ignored',
			),
			'two',
		),
	).toEqual({
		orgSlug: 'team',
		memoryId: 'two',
		selected: 'one',
		query: 'meeting',
		includeDeleted: true,
	})
	expect(
		memoriesInput('team', defaultParseSearch('?includeDeleted=false')),
	).toEqual({
		orgSlug: 'team',
		memoryId: undefined,
		selected: undefined,
		query: '',
		includeDeleted: false,
	})
})
