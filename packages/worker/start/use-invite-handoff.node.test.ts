import { expect, test, vi } from 'vitest'

vi.mock('react', () => ({
	useState: <T>(initial: T | (() => T)) => {
		let value = typeof initial === 'function' ? (initial as () => T)() : initial
		return [
			value,
			(next: T | ((current: T) => T)) => {
				value =
					typeof next === 'function' ? (next as (current: T) => T)(value) : next
			},
		]
	},
}))

import { parkInviteHandoff, useInviteHandoff } from './use-invite-handoff.ts'

test('a handoff parked for one package shows only when that package mounts again', () => {
	const invite = { id: 'invite-a', prompt: 'one-time link' }
	parkInviteHandoff('actor/owner/package-a', invite)

	expect(useInviteHandoff(undefined, 'actor/owner/package-b')[0]).toBeNull()
	expect(useInviteHandoff(undefined)[0]).toBeNull()
	expect(useInviteHandoff(undefined, 'actor/owner/package-a')[0]).toBe(invite)
})

test('clearing a keyed handoff forgets it for the next mount', () => {
	parkInviteHandoff('actor/owner/package-c', { id: 'invite-c' })
	const [, setCreated] = useInviteHandoff<{ id: string }>(
		undefined,
		'actor/owner/package-c',
	)
	setCreated(null)

	expect(useInviteHandoff(undefined, 'actor/owner/package-c')[0]).toBeNull()
})
