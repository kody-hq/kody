import { expect, it } from 'vitest'
import { commandCatalog } from './catalog.ts'
import { parseSessionInfo } from '#client/session.ts'
it('keeps member-only destinations and actions out of collaborator workspaces', () => {
	const session = parseSessionInfo({
		ok: true,
		session: {
			email: 'test@example.com',
			username: 'test',
			roles: [],
			organizations: [
				{ slug: 'team', displayName: 'Team', role: null, personal: false },
			],
		},
	})
	const commands = commandCatalog(session, 'team', '/@team/-/agents')
	expect(commands.some((command) => command.title === 'Agents')).toBe(true)
	expect(commands.some((command) => command.title === 'Billing')).toBe(false)
	expect(
		commands.some((command) => command.title === 'Create repository'),
	).toBe(false)
})
it('includes navigation tabs and creation actions for an owner', () => {
	const session = parseSessionInfo({
		ok: true,
		session: {
			email: 'test@example.com',
			username: 'test',
			roles: [],
			organizations: [
				{ slug: 'team', displayName: 'Team', role: 'owner', personal: false },
			],
		},
	})
	const commands = commandCatalog(session, 'team', '/@team/-/jobs')
	expect(commands.some((command) => command.title === 'Workflows')).toBe(true)
	expect(
		commands.some((command) => command.title === 'Create repository'),
	).toBe(true)
	expect(commands.some((command) => command.title === 'Billing')).toBe(true)
	expect(new Set(commands.map((command) => command.id)).size).toBe(
		commands.length,
	)
})
