import { expect, test } from 'vitest'
import { findStaleMigrationPrefixes } from './check-migration-prefix-against-main.ts'

test('flags added migrations at or below the base tip maximum prefix', () => {
	const baseFilenames = ['0239-a.sql', '0241-other-pr.sql']
	expect(
		findStaleMigrationPrefixes({
			added: ['0240-mine.sql', '0241-mine.sql', '0242-mine.sql'],
			baseFilenames,
		}),
	).toEqual({
		baseMaximumPrefix: 241,
		stale: ['0240-mine.sql', '0241-mine.sql'],
	})
	expect(
		findStaleMigrationPrefixes({ added: ['0242-mine.sql'], baseFilenames }),
	).toEqual({ baseMaximumPrefix: 241, stale: [] })
	expect(
		findStaleMigrationPrefixes({
			added: ['0241-other-pr.sql'],
			baseFilenames,
		}).stale,
	).toEqual([])
})
