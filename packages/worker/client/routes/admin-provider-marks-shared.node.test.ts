import { expect, test } from 'vitest'

import type { AdminProviderMark } from '#universal/loader-data.ts'
import {
	filterMarks,
	groupMarks,
	markGroupKey,
	splitAliasInput,
} from './admin-provider-marks-shared.ts'

function mark(
	overrides: Partial<AdminProviderMark> & Pick<AdminProviderMark, 'slug'>,
): AdminProviderMark {
	return {
		label: overrides.slug,
		aliases: [],
		builtInAliases: [],
		logoPath: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	}
}

test('provider mark catalog groups, filters, and splits aliases', () => {
	expect(markGroupKey('github')).toBe('G')
	expect(markGroupKey('1password')).toBe('#')
	expect(splitAliasInput(' github.com, API.GitHub.com\nlinear.app ')).toEqual([
		'github.com',
		'API.GitHub.com',
		'linear.app',
	])

	const marks = [
		mark({
			slug: 'github',
			label: 'GitHub',
			aliases: ['github.com'],
			builtInAliases: ['api.github.com'],
		}),
		mark({ slug: 'google', label: 'Google' }),
		mark({ slug: '1password', label: '1Password' }),
		mark({ slug: 'gitlab', label: 'GitLab' }),
	]
	expect(groupMarks(marks).map((group) => group.key)).toEqual(['#', 'G'])
	expect(groupMarks(marks)[1]?.marks.map((item) => item.slug)).toEqual([
		'github',
		'google',
		'gitlab',
	])
	expect(filterMarks(marks, 'github.com').map((item) => item.slug)).toEqual([
		'github',
	])
	expect(filterMarks(marks, 'api.github.com').map((item) => item.slug)).toEqual(
		['github'],
	)
	expect(filterMarks(marks, 'lab').map((item) => item.slug)).toEqual(['gitlab'])
})
