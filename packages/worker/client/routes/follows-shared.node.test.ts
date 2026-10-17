import { expect, test } from 'vitest'
import {
	describeFollowEvents,
	describePausedFollow,
	followEventOptions,
	followEventsToSubmit,
	followErrorMessage,
	initialFollowEventChoice,
} from '#client/routes/follows-shared.ts'

test('describeFollowEvents reads as a sentence in display order', () => {
	expect(describeFollowEvents(['pushed', 'published'])).toBe(
		'New versions and pushes',
	)
	expect(describeFollowEvents(['pushed'])).toBe('Pushes')
	expect(describeFollowEvents([])).toBe('nothing')
})

test('describePausedFollow names the reason only for paused follows', () => {
	expect(
		describePausedFollow({ status: 'paused', pausedReason: 'access_lost' }),
	).toBe('Paused. Whoever followed it no longer has read access.')
	expect(
		describePausedFollow({ status: 'paused', pausedReason: 'target_missing' }),
	).toMatch(/deleted or moved/)
	expect(
		describePausedFollow({ status: 'active', pausedReason: null }),
	).toBeNull()
})

test('pushes are offered only with read access, with the reason when not', () => {
	const target = { name: '@ada/notes', kind: 'package' as const }
	const gated = followEventOptions({
		availableEvents: ['published', 'pushed'],
		canPush: false,
		target,
	})
	expect(gated.map((option) => [option.event, option.disabledReason])).toEqual([
		['published', null],
		[
			'pushed',
			'Pushes need read access to @ada/notes. A Use grant includes read; run-only access does not.',
		],
	])
	expect(
		followEventOptions({
			availableEvents: ['pushed'],
			canPush: true,
			target: { ...target, kind: 'repo' },
		}).map((option) => option.disabledReason),
	).toEqual([null])
})

test('initialFollowEventChoice keeps an existing choice and defaults to what is allowed', () => {
	expect(
		initialFollowEventChoice(
			{ availableEvents: ['published', 'pushed'], canPush: false },
			null,
		),
	).toEqual(['published'])
	expect(
		initialFollowEventChoice(
			{ availableEvents: ['published', 'pushed'], canPush: true },
			null,
		),
	).toEqual(['published', 'pushed'])
	expect(
		initialFollowEventChoice(
			{ availableEvents: ['published', 'pushed'], canPush: true },
			{
				status: 'active',
				events: ['pushed'],
				pausedAt: null,
				pausedReason: null,
				lastDeliverySkipReason: null,
			},
		),
	).toEqual(['pushed'])
})

test('followEventsToSubmit keeps an untouched choice and drops gated events only on edit', () => {
	const state: Parameters<typeof followEventsToSubmit>[0] = {
		availableEvents: ['published', 'pushed'],
		canPush: false,
	}
	const stored: Parameters<typeof followEventsToSubmit>[1] = {
		events: ['published', 'pushed'],
	}

	expect(followEventsToSubmit(state, stored, ['pushed', 'published'])).toEqual({
		events: undefined,
		dropsGated: false,
	})
	expect(
		followEventsToSubmit(state, { events: ['pushed'] }, ['pushed']),
	).toEqual({ events: undefined, dropsGated: false })
	expect(
		followEventsToSubmit(state, { events: ['pushed'] }, [
			'pushed',
			'published',
		]),
	).toEqual({ events: ['published'], dropsGated: true })
	expect(followEventsToSubmit(state, null, ['published'])).toEqual({
		events: ['published'],
		dropsGated: false,
	})
	expect(
		followEventsToSubmit({ ...state, canPush: true }, stored, ['pushed']),
	).toEqual({ events: ['pushed'], dropsGated: false })
})

test('rate-limit errors name the workspace limit', () => {
	expect(
		followErrorMessage({
			ok: false,
			code: 'rate_limited',
			error: 'Follow limit reached for this org.',
		}),
	).toMatch(/30 things in the last hour/)
	expect(
		followErrorMessage({ ok: false, code: 'invalid', error: 'Nope.' }),
	).toBe('Nope.')
})
