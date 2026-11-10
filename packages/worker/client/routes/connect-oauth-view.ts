import type {
	ConnectOauthExistingConnection,
	ConnectOauthLoaderData,
} from '#universal/loader-data.ts'
import type {
	ConnectOauthConfig,
	StoredIntegrationConfig,
	ConnectOauthNextSteps,
} from '#client/routes/connect-oauth-config-types.ts'
import type { ConnectOauthStep } from './connect-oauth-state.ts'
type ConnectOauthStatusTone = 'info' | 'warn' | 'error'
type ConnectOauthChooserOption = NonNullable<
	ConnectOauthLoaderData['chooser']
>['options'][number]
type LiveReplaceState = {
	mode: 'choose' | 'new-name'
	newName: string
	nameError: string | null
}
export type OauthState = {
	statusMessage: string
	statusTone: ConnectOauthStatusTone
	currentStep: ConnectOauthStep
	config: ConnectOauthConfig | null
	existingIntegrationConfig: StoredIntegrationConfig | null
	accessTokenSaved: boolean
	refreshTokenSaved: boolean
	hasConfigError: boolean
	existingConnection: ConnectOauthExistingConnection | null
	replaceConfirmed: boolean
	/** Set while the setup save waits on the live-app replace choice. */
	liveReplace: LiveReplaceState | null
	chooserOptions: Array<ConnectOauthChooserOption>
	chooserFilter: string
	requestedProvider: string | null
	offeredScopeMenu: Array<string>
	nextSteps: ConnectOauthNextSteps | null
	submitting: boolean
	ssrRedirectUri: string | null
	clientIdInput: string
	clientSecretInput: string
	hasStoredClientId: boolean
	hasStoredClientSecret: boolean
	revealStoredClientSecretField: boolean
}
type Receipt = Pick<
	OauthState,
	'accessTokenSaved' | 'refreshTokenSaved' | 'nextSteps'
>
type Feedback = {
	[K in ConnectOauthStatusTone]: { tone: K; message: string }
}[ConnectOauthStatusTone]
type Context = Omit<
	OauthState,
	keyof Receipt | 'statusMessage' | 'statusTone' | 'currentStep' | 'submitting'
>
export type ConnectOauthUiState = Context & { feedback: Feedback } & (
		| {
				status: Exclude<ConnectOauthStep, 'success'>
				request: 'idle' | 'submitting'
		  }
		| { status: 'success'; receipt: Receipt }
	)
export function toConnectOauthUi(draft: OauthState): ConnectOauthUiState {
	const {
		currentStep,
		submitting,
		statusMessage,
		statusTone,
		accessTokenSaved,
		refreshTokenSaved,
		nextSteps,
		...context
	} = draft
	const feedback: Feedback = { tone: statusTone, message: statusMessage }
	if (currentStep === 'success')
		return {
			...context,
			status: currentStep,
			feedback,
			receipt: { accessTokenSaved, refreshTokenSaved, nextSteps },
		}
	return {
		...context,
		status: currentStep,
		feedback,
		request: submitting ? 'submitting' : 'idle',
	}
}
export function projectConnectOauthUi(state: ConnectOauthUiState): OauthState {
	if (state.status === 'success') {
		const { status, receipt, feedback, ...context } = state
		return {
			...context,
			...receipt,
			currentStep: status,
			statusMessage: feedback.message,
			statusTone: feedback.tone,
			submitting: false,
		}
	}
	const { status, request, feedback, ...context } = state
	return {
		...context,
		currentStep: status,
		statusMessage: feedback.message,
		statusTone: feedback.tone,
		submitting: request === 'submitting',
		accessTokenSaved: false,
		refreshTokenSaved: false,
		nextSteps: null,
	}
}
