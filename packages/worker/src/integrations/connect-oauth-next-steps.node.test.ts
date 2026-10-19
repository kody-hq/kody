import { expect, test } from 'vitest'
import { buildConnectOauthNextSteps } from './connect-oauth-next-steps.ts'

function githubIntegration() {
	return {
		name: 'github',
		tokenUrl: 'https://github.com/login/oauth/access_token',
		apiBaseUrl: 'https://api.github.com',
		requiredHosts: ['api.github.com'],
		authorization: {
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			scopes: ['repo'],
		},
	}
}

test('buildConnectOauthNextSteps resolves the provider display name for the connection', () => {
	const github = buildConnectOauthNextSteps({
		integrationName: 'github',
		integration: githubIntegration(),
	})
	expect(github.service).toBe('github')
	expect(github.connectionName).toBe('github')

	const googleBusiness = buildConnectOauthNextSteps({
		integrationName: 'google-business',
		integration: {
			name: 'google-business',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			apiBaseUrl: 'https://www.googleapis.com/calendar/v3',
			requiredHosts: ['www.googleapis.com'],
			authorization: {
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				scopes: ['https://www.googleapis.com/auth/calendar'],
			},
		},
	})
	expect(googleBusiness.service).toBe('google')
	expect(googleBusiness.connectionName).toBe('google-business')
})
