import { expect, test } from 'vitest'
import { parseSessionInfo } from './session.ts'

test('parseSessionInfo keeps organization photos the chooser draws', async () => {
	const payload = {
		ok: true,
		session: {
			email: 'ada@example.com',
			username: 'ada',
			avatarUrl: ' /profiles/ada/avatar/person.png ',
			organizations: [
				{
					slug: 'ada',
					displayName: 'Ada',
					role: 'owner',
					personal: true,
					avatarUrl: null,
				},
				{
					slug: 'acme',
					displayName: 'Acme',
					role: 'owner',
					personal: false,
					avatarUrl: ' /orgs/acme/avatar/hash.png ',
				},
				{
					slug: 'blank',
					displayName: null,
					role: 'member',
					personal: false,
					avatarUrl: '   ',
				},
				{
					slug: ' ',
					displayName: 'Skipped',
					role: 'owner',
					personal: false,
					avatarUrl: '/orgs/skipped/avatar/x.png',
				},
			],
		},
	}
	const session = parseSessionInfo(payload)
	expect(session?.avatarUrl).toBe('/profiles/ada/avatar/person.png')
	expect(session?.organizations).toEqual([
		{
			slug: 'ada',
			displayName: 'Ada',
			role: 'owner',
			personal: true,
			avatarUrl: null,
		},
		{
			slug: 'acme',
			displayName: 'Acme',
			role: 'owner',
			personal: false,
			avatarUrl: '/orgs/acme/avatar/hash.png',
		},
		{
			slug: 'blank',
			displayName: null,
			role: 'member',
			personal: false,
			avatarUrl: null,
		},
	])
})
