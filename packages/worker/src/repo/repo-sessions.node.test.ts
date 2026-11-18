import { expect, test } from 'vitest'
import {
	isRepoSessionDue,
	nextOwnerDueAt,
	nextRepoSessionDueAt,
	sourceSyncSessionIdPrefix,
} from './repo-session-due.ts'

test('due helpers treat unused leftovers sooner than edited sessions', () => {
	const now = new Date('2026-06-24T20:00:00.000Z')
	expect(
		isRepoSessionDue(
			{
				status: 'active',
				last_checkpoint_at: null,
				updated_at: '2026-06-24T19:00:00.000Z',
				expires_at: null,
			},
			now,
		),
	).toBe(true)
	expect(
		isRepoSessionDue(
			{
				status: 'active',
				last_checkpoint_at: null,
				updated_at: '2026-06-24T19:45:00.000Z',
				expires_at: null,
			},
			now,
		),
	).toBe(false)
	expect(
		isRepoSessionDue(
			{
				status: 'active',
				last_checkpoint_at: '2026-06-20T20:00:00.000Z',
				updated_at: '2026-06-20T20:00:00.000Z',
				expires_at: null,
			},
			now,
		),
	).toBe(false)
	expect(
		isRepoSessionDue(
			{
				status: 'active',
				last_checkpoint_at: '2026-06-16T20:00:00.000Z',
				updated_at: '2026-06-16T20:00:00.000Z',
				expires_at: null,
			},
			now,
		),
	).toBe(true)
	expect(
		isRepoSessionDue(
			{
				status: 'published',
				last_checkpoint_at: '2026-06-24T10:00:00.000Z',
				updated_at: '2026-06-24T10:00:00.000Z',
				expires_at: '2026-06-24T12:00:00.000Z',
			},
			now,
		),
	).toBe(true)
	expect(
		isRepoSessionDue(
			{
				status: 'published',
				last_checkpoint_at: '2026-06-24T10:00:00.000Z',
				updated_at: '2026-06-24T10:00:00.000Z',
				expires_at: '2026-06-25T12:00:00.000Z',
			},
			now,
		),
	).toBe(false)
	expect(
		nextRepoSessionDueAt({
			status: 'active',
			last_checkpoint_at: null,
			updated_at: '2026-06-24T19:00:00.000Z',
			expires_at: null,
		}),
	).toBe('2026-06-24T19:30:00.000Z')
	expect(
		nextOwnerDueAt([
			{
				status: 'active',
				last_checkpoint_at: null,
				updated_at: '2026-06-24T19:00:00.000Z',
				expires_at: null,
			},
			{
				status: 'published',
				last_checkpoint_at: '2026-06-24T10:00:00.000Z',
				updated_at: '2026-06-24T10:00:00.000Z',
				expires_at: '2026-06-24T12:00:00.000Z',
			},
		]),
	).toBe('2026-06-24T12:00:00.000Z')
})

test('a package-save session that never reached publish sweeps like a leftover', () => {
	const now = new Date('2026-06-24T20:00:00.000Z')
	const abandoned = {
		id: `${sourceSyncSessionIdPrefix}source-1-run-1`,
		status: 'active' as const,
		base_commit: 'base',
		last_checkpoint_commit: 'base',
		last_checkpoint_at: '2026-06-24T19:00:00.000Z',
		updated_at: '2026-06-24T19:00:00.000Z',
		expires_at: null,
	}
	expect(isRepoSessionDue(abandoned, now)).toBe(true)
	// A publish paused for approval commits first; it keeps the long window.
	expect(
		isRepoSessionDue({ ...abandoned, last_checkpoint_commit: 'paused' }, now),
	).toBe(false)
	// Agent sessions with edits keep the long window too.
	expect(isRepoSessionDue({ ...abandoned, id: 'agent-session' }, now)).toBe(
		false,
	)
})
