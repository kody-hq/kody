import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { requireMcpUserWithPermission } from './require-permission.ts'

test('requireMcpUserWithPermission authenticates before checking the permission', () => {
	expect(() =>
		requireMcpUserWithPermission(
			createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://example.com',
			}),
			'read:user:any',
		),
	).toThrow()

	expect(() =>
		requireMcpUserWithPermission(
			createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://example.com',
				user: {
					userId: personIdFromStored('user-1'),
					email: 'user@example.com',
					displayName: 'user',
					roles: ['user'],
					permissions: ['read:user:own'],
				},
			}),
			'read:user:any',
		),
	).toThrow()

	expect(() =>
		requireMcpUserWithPermission(
			createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://example.com',
				user: {
					userId: personIdFromStored('user-1'),
					email: 'user@example.com',
					displayName: 'user',
				},
			}),
			'read:user:any',
		),
	).toThrow()

	const user = {
		userId: personIdFromStored('user-1'),
		email: 'admin@example.com',
		displayName: 'admin',
		roles: ['admin'],
		permissions: ['read:user:any', 'read:role:any'],
	}
	expect(
		requireMcpUserWithPermission(
			createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://example.com',
				user,
			}),
			'read:user:any',
		),
	).toEqual(user)
})
