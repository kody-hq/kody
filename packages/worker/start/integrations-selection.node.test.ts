import { expect, test } from 'vitest'
import { resolveIntegrationsSelection } from './pages/account-integrations-shared.ts'

test('decoded connection identity is used directly, including route-like characters', () => {
	const result = resolveIntegrationsSelection({
		selection: { kind: 'connection', connectionName: 'service/approve.new' },
		apps: [],
		integrations: [],
	})
	expect(result.highlightedConnectionName).toBe('service/approve.new')
	expect(result.missingKind).toBe('connection')
})

test('an app detail remains distinct from a connection with the same name', () => {
	const result = resolveIntegrationsSelection({
		selection: { kind: 'app', appSlug: 'approve' },
		apps: [],
		integrations: [],
	})
	expect(result.highlightedConnectionName).toBeNull()
	expect(result.missingKind).toBe('integration')
})

test.each(['list', 'approval'] as const)(
	'%s has no missing selected entity',
	(kind) => {
		expect(
			resolveIntegrationsSelection({
				selection: { kind },
				apps: [],
				integrations: [],
			}),
		).toEqual({
			selectedApp: null,
			highlightedConnectionName: null,
			missingKind: null,
		})
	},
)
