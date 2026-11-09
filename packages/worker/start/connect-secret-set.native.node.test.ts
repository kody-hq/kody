import { expect, test } from 'vitest'
import { readConnectSecretSetView } from './pages/connect-secret-set-shared.ts'

test('connect secret-set view focuses the form when a name is present', () => {
	expect(
		readConnectSecretSetView({
			name: 'exampleApiKey',
			saved: false,
		}),
	).toEqual({
		hasName: true,
		saved: false,
		showForm: true,
		showBackToSecrets: false,
	})

	expect(
		readConnectSecretSetView({
			name: '',
			saved: false,
		}),
	).toEqual({
		hasName: false,
		saved: false,
		showForm: false,
		showBackToSecrets: true,
	})

	expect(
		readConnectSecretSetView({
			name: 'exampleApiKey',
			saved: true,
		}),
	).toEqual({
		hasName: true,
		saved: true,
		showForm: false,
		showBackToSecrets: true,
	})
})
