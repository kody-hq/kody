/** @jsxImportSource @emotion/react */
import { useServerFn } from '@tanstack/react-start'
import {
	getHandleFormatError,
	suggestHandle,
} from '@kody-internal/shared/handle-rules.ts'
import { validateAuthFormFields } from '#client/auth-form-validation.ts'
import { buildAuthLink } from '#client/auth-links.ts'
import { fathomEventNames, trackFathomEvent } from '#client/fathom-events.ts'
import {
	clearStoredFirstTouchAttribution,
	readSignupFirstTouchAttribution,
} from '#client/first-touch-attribution.ts'
import {
	emptyPublicFormProtection,
	readPublicFormProtection,
	renderTurnstileWidgets,
	resetTurnstileWidgets,
} from '#client/public-form-protection.ts'
import { resolvePasswordAuthRedirect } from '#client/routes/resolve-password-auth-redirect.ts'
import {
	authenticateWebsite as authenticateWebsiteFn,
	webauthnAuthenticationOptions as webauthnAuthenticationOptionsFn,
	webauthnAuthenticationVerify as webauthnAuthenticationVerifyFn,
} from '#start/server/auth-mutations'
import { buildOauthLoginErrorAgentPrompt } from '#universal/error-agent-prompt-presets.ts'
import { withAccountCreatedQuery } from '#universal/fathom-events.ts'
import { serializeFirstTouchAttributionForTransport } from '#universal/first-touch-attribution.ts'
import { getOauthLoginErrorMessage } from '#universal/oauth-login-errors.ts'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import { getGhostButtonCss } from '#universal/styles/style-primitives.ts'
import { colors } from '#universal/styles/tokens.ts'
import { type CSSObject } from '@emotion/react'
import { handlePermanenceConfirmMessage } from '@kody-internal/shared/handle-permanence.ts'
import {
	startAuthentication,
	WebAuthnAbortService,
} from '@simplewebauthn/browser'
import {
	useEffect,
	useId,
	useRef,
	useState,
	type CSSProperties,
	type FormEvent,
} from 'react'
import { AuthLayout } from '../components/auth-layout.tsx'
import { ErrorAgentPromptButton } from '../components/error-agent-prompt-button.tsx'
import { ProviderIcon } from '../components/provider-icons.tsx'
import { SiteLink } from '../components/site-link.tsx'
import { useHydrated } from '../components/use-hydrated.ts'
import { useSocialSignIn, type PublicAuthConfig } from '../social-sign-in.ts'
import { type UsernameAvailabilityView } from '../components/username-choice-field.tsx'
import { AuthForm, formMessageCss } from './login-sections.tsx'

export type AuthStatus = 'idle' | 'submitting' | 'success' | 'error'
function buildAuthPath(mode: 'login' | 'signup', redirectTo: string | null) {
	return buildAuthLink(mode === 'signup' ? '/signup' : '/login', redirectTo)
}
export function LoginPage({
	mode,
	currentHref,
	authConfig,
}: {
	mode: 'login' | 'signup'
	currentHref: string
	authConfig: PublicAuthConfig
}) {
	const startSocialSignIn = useSocialSignIn()
	const authenticateWebsite = useServerFn(authenticateWebsiteFn)
	const webauthnAuthenticationOptions = useServerFn(
		webauthnAuthenticationOptionsFn,
	)
	const webauthnAuthenticationVerify = useServerFn(
		webauthnAuthenticationVerifyFn,
	)
	const hydrated = useHydrated()
	const [status, setStatus] = useState<AuthStatus>('idle')
	const [message, setMessage] = useState<string | null>(null)
	const [signupUsername, setSignupUsername] = useState('')
	const [signupEmail, setSignupEmail] = useState('')
	const [usernameAvailability, setUsernameAvailability] =
		useState<UsernameAvailabilityView>({ status: 'idle' })
	const usernameTouched = useRef(false)
	const [confirmedUsername, setConfirmedUsername] = useState<string | null>(
		null,
	)
	const handleId = useId()
	const lifecycle = useRef<AbortController | null>(null)
	const signupStartedTracked = useRef(false)
	const { providers: authProviders, turnstileSiteKey } = authConfig
	const searchParams = new URL(currentHref, 'https://kody.local').searchParams
	const redirectTo = normalizeRedirectTo(searchParams.get('redirectTo'))
	useEffect(() => {
		const controller = new AbortController()
		lifecycle.current = controller
		if (turnstileSiteKey) renderTurnstileWidgets(turnstileSiteKey)
		if (mode === 'signup' && !signupStartedTracked.current) {
			readSignupFirstTouchAttribution()
			signupStartedTracked.current = trackFathomEvent(
				fathomEventNames.signupStarted,
			)
		}
		return () => {
			controller.abort()
			WebAuthnAbortService.cancelCeremony()
		}
	}, [mode, currentHref, turnstileSiteKey])
	function setState(nextStatus: AuthStatus, nextMessage: string | null = null) {
		if (lifecycle.current?.signal.aborted) return
		setStatus(nextStatus)
		setMessage(nextMessage)
	}

	/**
	 * Report a failure that came back from the server. The challenge token the
	 * request carried is spent (Turnstile tokens are single-use), and the form
	 * stays mounted for another try, so it needs a fresh one. Plain `setState`
	 * still covers client-side validation, where nothing was sent and the
	 * token the user already solved is still good.
	 */
	function setSubmitError(nextMessage: string) {
		if (lifecycle.current?.signal.aborted) return
		resetTurnstileWidgets()
		setState('error', nextMessage)
	}

	function clearFieldError() {
		if (status === 'error') setState('idle')
	}

	async function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		const form = event.currentTarget

		const formData = new FormData(form)
		const email = String(formData.get('email') ?? '').trim()
		const password = String(formData.get('password') ?? '')
		const username =
			mode === 'signup' ? String(formData.get('username') ?? '').trim() : ''
		const rememberMe = mode === 'login' && formData.get('rememberMe') === 'on'
		const protection = readPublicFormProtection(formData, form)

		const clientValidation = validateAuthFormFields({
			mode,
			email,
			password,
			username,
		})
		if (clientValidation) {
			if (clientValidation.field === 'username') usernameTouched.current = true
			setState('error', clientValidation.message)
			return
		}

		if (mode === 'signup') {
			if (
				usernameAvailability.status === 'taken' ||
				usernameAvailability.status === 'reserved' ||
				usernameAvailability.status === 'invalid'
			) {
				setState(
					'error',
					usernameAvailability.reason ?? 'That username cannot be used.',
				)
				return
			}
			if (confirmedUsername !== username.toLowerCase()) {
				setConfirmedUsername(username.toLowerCase())
				setSignupUsername(username)
				setState('idle', handlePermanenceConfirmMessage(username.toLowerCase()))
				return
			}
			if (usernameAvailability.status === 'checking') {
				setState('error', 'Wait for the availability check to finish.')
				return
			}
		}

		setState('submitting')

		try {
			const attribution =
				mode === 'signup' ? readSignupFirstTouchAttribution() : null
			const payload = await authenticateWebsite({
				signal: lifecycle.current?.signal,
				data: {
					email,
					password,
					mode,
					rememberMe,
					...protection,
					...(mode === 'signup'
						? {
								username,
								redirectTo: redirectTo,
								...serializeFirstTouchAttributionForTransport(attribution),
							}
						: {}),
				},
			})
			if (!payload) return
			if (lifecycle.current?.signal.aborted) return

			if (!payload.successful) {
				const errorMessage =
					typeof payload?.error === 'string'
						? payload.error
						: 'Unable to authenticate.'
				setSubmitError(errorMessage)
				return
			}

			if (mode === 'signup') {
				const tracked = trackFathomEvent(fathomEventNames.accountCreated)
				clearStoredFirstTouchAttribution()
				if (typeof window !== 'undefined') {
					const destination = resolvePasswordAuthRedirect({
						mode,
						requiresTwoFactor: payload?.requiresTwoFactor === true,
						emailVerificationRequired:
							payload?.emailVerificationRequired === true,
						redirectTo: redirectTo,
					})
					window.location.assign(
						tracked ? destination : withAccountCreatedQuery(destination),
					)
				}
				return
			}

			if (typeof window !== 'undefined') {
				window.location.assign(
					resolvePasswordAuthRedirect({
						mode,
						requiresTwoFactor: payload?.requiresTwoFactor === true,
						emailVerificationRequired:
							payload?.emailVerificationRequired === true,
						redirectTo: redirectTo,
					}),
				)
			}
		} catch {
			setSubmitError('Network error. Please try again.')
		}
	}

	async function handleProviderSignIn(providerId: string) {
		setState('submitting')
		try {
			const authForm = document.querySelector<HTMLFormElement>(
				'form[data-public-auth-form]',
			)
			const protection = authForm
				? readPublicFormProtection(new FormData(authForm), authForm)
				: emptyPublicFormProtection()
			const errorMessage = await startSocialSignIn(
				providerId,
				redirectTo,
				protection,
				mode === 'signup' ? readSignupFirstTouchAttribution() : null,
				lifecycle.current?.signal,
			)
			if (errorMessage) {
				setSubmitError(errorMessage)
			}
			// On success the browser is navigating to the provider; leave the
			// submitting state in place.
		} catch {
			setSubmitError('Network error. Please try again.')
		}
	}

	async function handlePasskeySignIn() {
		setState('submitting')

		try {
			const optionsPayload = await webauthnAuthenticationOptions({ data: {} })
			if (!optionsPayload) return
			if (
				!optionsPayload.successful ||
				optionsPayload?.ok !== true ||
				!optionsPayload.options
			) {
				setState('error', 'Unable to start passkey sign-in.')
				return
			}

			let authenticationResponse
			try {
				authenticationResponse = await startAuthentication({
					optionsJSON: optionsPayload.options,
				})
			} catch {
				setState('idle')
				return
			}

			if (lifecycle.current?.signal.aborted) return
			const rememberMeInput = document.querySelector('input[name="rememberMe"]')
			const rememberMe =
				rememberMeInput instanceof HTMLInputElement && rememberMeInput.checked
			const authForm = document.querySelector<HTMLFormElement>(
				'form[data-public-auth-form]',
			)
			const protection = authForm
				? readPublicFormProtection(new FormData(authForm), authForm)
				: emptyPublicFormProtection()

			const verificationPayload = await webauthnAuthenticationVerify({
				data: {
					response: authenticationResponse,
					rememberMe,
					...protection,
				},
			})
			if (lifecycle.current?.signal.aborted) return
			if (!verificationPayload) return
			if (!verificationPayload.successful || verificationPayload?.ok !== true) {
				const errorMessage =
					typeof verificationPayload?.error === 'string'
						? verificationPayload.error
						: 'Passkey sign-in failed.'
				setSubmitError(errorMessage)
				return
			}

			window.location.assign(
				resolvePasswordAuthRedirect({
					mode: 'login',
					requiresTwoFactor: verificationPayload.requiresTwoFactor === true,
					redirectTo: redirectTo,
				}),
			)
		} catch {
			setSubmitError('Network error. Please try again.')
		}
	}

	const oauthErrorMessage =
		!message && status === 'idle'
			? getOauthLoginErrorMessage(searchParams.get('oauthError'))
			: null
	const isSignup = mode === 'signup'
	const isSubmitting = status === 'submitting'
	const title = isSignup ? 'Create your account' : 'Welcome back'
	const description = isSignup
		? 'Create an account and start building automations you own.'
		: 'Sign in to pick up where you left off.'
	const submitLabel = isSignup
		? confirmedUsername
			? 'Yes, create account'
			: 'Create account'
		: 'Sign in'
	const submitBusyLabel = isSignup ? 'Creating account…' : 'Signing in…'
	const showSocial = authProviders.length > 0

	return (
		<AuthLayout title={title} description={description}>
			{oauthErrorMessage ? (
				<>
					<p aria-live="polite" data-tone="error" css={formMessageCss}>
						{oauthErrorMessage}
					</p>
					<ErrorAgentPromptButton
						prompt={buildOauthLoginErrorAgentPrompt({
							errorCode: searchParams.get('oauthError') ?? 'provider-error',
							errorMessage: oauthErrorMessage,
						})}
					/>
				</>
			) : null}

			<AuthForm
				handleId={handleId}
				turnstileSiteKey={turnstileSiteKey}
				status={status}
				message={message}
				isSubmitting={isSubmitting}
				isInteractive={hydrated}
				isSignup={isSignup}
				signupUsername={signupUsername}
				signupEmail={signupEmail}
				usernameConfirming={
					confirmedUsername !== null &&
					confirmedUsername === signupUsername.trim().toLowerCase()
				}
				onSignupEmailInput={(value) => {
					setSignupEmail(value)
					if (!usernameTouched.current) {
						const local = value.split('@')[0] ?? ''
						const suggestion = suggestHandle(local) ?? ''
						setSignupUsername(suggestion)
						setConfirmedUsername(null)
					}
				}}
				onSignupUsernameInput={(value) => {
					usernameTouched.current = true
					setSignupUsername(value)
					setConfirmedUsername(null)
					// Format errors stay in UsernameChoiceField; keep the form
					// message for submit / confirm copy only.
					setState('idle')
				}}
				onUsernameAvailabilityChange={setUsernameAvailability}
				submitLabel={submitLabel}
				submitBusyLabel={submitBusyLabel}
				onSubmit={handleSubmit}
				onPasskeySignIn={handlePasskeySignIn}
				onFieldEdit={() => {
					if (mode === 'signup' && getHandleFormatError(signupUsername)) return
					clearFieldError()
				}}
			/>

			{showSocial ? (
				<>
					<div
						data-rise
						style={{ '--rise': '2' } as CSSProperties}
						role="separator"
						aria-label="or continue with"
						css={authDividerCss}
					>
						<span>or continue with</span>
					</div>
					<div
						data-rise
						style={{ '--rise': '3' } as CSSProperties}
						css={authOauthCss}
					>
						{authProviders.map((provider) => (
							<button
								key={provider.id}
								type="button"
								disabled={!hydrated || isSubmitting}
								aria-label={`Continue with ${provider.label}`}
								data-testid={`social-sign-in-${provider.id}`}
								css={oauthButtonCss}
								onClick={() => handleProviderSignIn(provider.id)}
							>
								<ProviderIcon providerId={provider.id} size="1.4rem" />
							</button>
						))}
					</div>
				</>
			) : null}

			<footer
				data-rise
				style={{ '--rise': '4' } as CSSProperties}
				css={authFootCss}
			>
				{isSignup ? (
					<p>
						Already have an account?{' '}
						<SiteLink href={buildAuthPath('login', redirectTo)}>
							Sign in
						</SiteLink>
						.
					</p>
				) : (
					<p>
						New here?{' '}
						<SiteLink href={buildAuthPath('signup', redirectTo)}>
							Create an account
						</SiteLink>
						.
					</p>
				)}
				<p css={authLegalCss}>
					<SiteLink href="/privacy">Privacy</SiteLink>
					<SiteLink href="/terms">Terms</SiteLink>
				</p>
			</footer>
		</AuthLayout>
	)
}

const authDividerCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.9rem',
	color: colors.textMuted,
	fontSize: '0.88rem',
	'&::before': {
		content: '""',
		flex: 1,
		height: '1px',
		background: colors.border,
	},
	'&::after': {
		content: '""',
		flex: 1,
		height: '1px',
		background: colors.border,
	},
}

const authOauthCss: CSSObject = {
	display: 'flex',
	justifyContent: 'center',
	flexWrap: 'wrap' as const,
	gap: '0.7rem',
}

const oauthButtonCss: CSSObject = {
	...getGhostButtonCss(),
	flex: '0 0 auto',
	width: '3rem',
	height: '3rem',
	minWidth: '3rem',
	padding: 0,
	'& svg': {
		display: 'block',
		flexShrink: 0,
	},
}

const authFootCss: CSSObject = {
	borderTop: `1px solid ${colors.border}`,
	paddingTop: '1.3rem',
	display: 'grid',
	gap: '0.6rem',
	'& p': {
		margin: 0,
		fontSize: '0.95rem',
		color: colors.textMuted,
		textAlign: 'center' as const,
		marginInline: 'auto',
	},
	'& a': {
		color: colors.primaryText,
		textDecorationThickness: '1.5px',
		textUnderlineOffset: '3px',
	},
	'& a:hover': { color: colors.text },
}

const authLegalCss: CSSObject = {
	display: 'flex',
	justifyContent: 'center',
	gap: '1.1rem',
	fontSize: '0.85rem',
	'& a': {
		color: colors.textMuted,
		textDecoration: 'none',
	},
	'& a:hover': { textDecoration: 'underline', color: colors.text },
}
