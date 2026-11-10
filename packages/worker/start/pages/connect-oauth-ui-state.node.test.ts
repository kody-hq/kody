import { expect, test } from 'vitest'
import {
	toConnectOauthUi,
	projectConnectOauthUi,
	type OauthState,
} from './connect-oauth-ui-state.ts'
const draft: OauthState = {
	statusMessage: 'Ready',
	statusTone: 'info',
	currentStep: 'connect',
	config: null,
	existingIntegrationConfig: null,
	accessTokenSaved: false,
	refreshTokenSaved: false,
	hasConfigError: false,
	existingConnection: null,
	replaceConfirmed: false,
	liveReplace: null,
	chooserOptions: [],
	chooserFilter: '',
	requestedProvider: null,
	offeredScopeMenu: [],
	nextSteps: null,
	submitting: false,
	ssrRedirectUri: null,
	clientIdInput: '',
	clientSecretInput: '',
	hasStoredClientId: false,
	hasStoredClientSecret: false,
	revealStoredClientSecretField: false,
}
test('step projections retain copy and context but only success owns a token receipt', () => {
	const idle = toConnectOauthUi(draft)
	expect(idle).not.toHaveProperty('receipt')
	expect(projectConnectOauthUi(idle)).toEqual(draft)
	const failed = toConnectOauthUi({
		...draft,
		statusTone: 'error',
		statusMessage: 'Failed',
		submitting: true,
	})
	expect(failed.feedback).toEqual({ tone: 'error', message: 'Failed' })
	const success = toConnectOauthUi({
		...draft,
		currentStep: 'success',
		accessTokenSaved: true,
	})
	expect(success).toHaveProperty('receipt.accessTokenSaved', true)
	expect(projectConnectOauthUi(success).accessTokenSaved).toBe(true)
})
