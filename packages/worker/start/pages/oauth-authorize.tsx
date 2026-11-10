/** @jsxImportSource @emotion/react */
import { uiState, uiContext, sendUiEvent } from '#client/ui-actor.ts'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useActor } from '@xstate/react'
import { resolveSignInStatusAfterPageshow } from '#client/routes/oauth-authorize-bfcache.ts'
import {
	oauthConsentState,
	type OAuthConsentState,
	type OAuthAuthorizeDecision,
} from '#client/routes/oauth-consent-state.ts'
import {
	emailVerificationState,
	type EmailVerificationState,
} from '#client/routes/email-verification-state.ts'
import { useServerFn } from '@tanstack/react-start'
import { submitOAuthDecision } from '#start/server/oauth-decision'
import { useSessionInfo } from '../session-info.ts'
import { buildAuthLink } from '#client/auth-links.ts'
import {
	emptyPublicFormProtection,
	honeypotFieldName,
	readPublicFormProtection,
	renderTurnstileWidgets,
	resetTurnstileWidgets,
	turnstileResponseFieldName,
	turnstileWidgetClassName,
} from '#client/public-form-protection.ts'
import { resolveAuthorizeEmailVerified } from '#client/routes/oauth-authorize-email-verified.ts'
import {
	oauthAuthorizeActionsDisabled,
	oauthAuthorizeApproveAriaLabel,
	oauthAuthorizeConsentDecision,
	oauthAuthorizeConsentFormAttrs,
	oauthAuthorizeEmailVerificationDenyDisabled,
	oauthAuthorizeGrantHeading,
	oauthAuthorizeOrgField,
} from '#client/routes/oauth-authorize-form.ts'
import { resolvePasswordAuthRedirect } from '#client/routes/resolve-password-auth-redirect.ts'
import { getSessionDisplayName, type SessionInfo } from '#client/session.ts'
import {
	webauthnAuthenticationOptions as webauthnAuthenticationOptionsFn,
	webauthnAuthenticationVerify as webauthnAuthenticationVerifyFn,
} from '#start/server/auth-mutations'
import {
	buildMcpAuthorizeClientFailureAgentPrompt,
	buildMcpAuthorizeErrorAgentPrompt,
} from '#universal/error-agent-prompt-presets.ts'
import {
	codexDcrLoginCommand,
	oauthAuthorizeClientDisplayName,
	oauthAuthorizeFetchStatusLabel,
	type OAuthAuthorizeClientFailure,
} from '#universal/oauth-authorize-client-failure.ts'
import type { OAuthAuthorizeLoaderData } from '#universal/loader-data.ts'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import {
	cardCss,
	descriptionCss,
	detailItemCss,
	detailLabelCss,
	fieldCss,
	fieldLabelCss,
	getAlertCardCss,
	getDangerButtonCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	inputCss,
	insetCardCss,
	listCss,
	mutedLinkCss,
	nativeDisclosureCss,
	pageDescriptionCss,
	sectionTitleCss,
	stackedPageCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { startAuthentication } from '@simplewebauthn/browser'
import { CopyTextButton } from '../components/copy-text-button.tsx'
import { ErrorAgentPromptButton } from '../components/error-agent-prompt-button.tsx'
import { Honeypot } from '../components/honeypot-field.tsx'
import { PasswordRevealInput } from '../components/password-reveal-input.tsx'
import { ProviderIcon } from '../components/provider-icons.tsx'
import { SiteLink } from '../components/site-link.tsx'
import { useHydrated } from '../components/use-hydrated.ts'
import { usePageInvalidation } from '../page-invalidation.ts'
import { useSocialSignIn, type PublicAuthConfig } from '../social-sign-in.ts'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import {
	renderEmailVerificationPrompt as EmailVerificationPrompt,
	useResendVerification,
} from './email-verification-prompt.tsx'
import { AuthorizeOrgField } from './oauth-authorize-org-picker.tsx'
import {
	OAuthAuthorizeConnectionHeader,
	OAuthAuthorizeDisconnectFooter,
	OAuthAuthorizeGuestConnected,
	OAuthAuthorizeSignedOutChoices,
} from './oauth-authorize-guest.tsx'
type OAuthAuthorizeStatus = 'idle' | 'loading' | 'ready' | 'error'

function oauthAuthorizeAccessLead(
	status: OAuthAuthorizeStatus,
	clientLabel: string,
) {
	switch (status) {
		case 'ready':
			return `${clientLabel} wants to access your kody account.`
		case 'idle':
		case 'loading':
			return 'Loading authorization details…'
		case 'error':
			return null
		default: {
			const exhaustive: never = status
			return exhaustive
		}
	}
}

/**
 * The OAuth client did not resolve. Two different stories: the app's
 * metadata host failed (on the app's side; retry, or for the Codex CLI use
 * dynamic registration), or Kody has no registration for the client (the app
 * must sign in again so it registers anew). Never shows the raw client id.
 */
function OAuthAuthorizeClientFailureCard(props: {
	failure: OAuthAuthorizeClientFailure
	retryHref: string
}) {
	const { failure } = props
	const prompt = buildMcpAuthorizeClientFailureAgentPrompt({ failure })
	if (failure.kind === 'missing_registration') {
		return (
			<section
				css={cardCss}
				data-testid="oauth-authorize-client-failure"
				data-failure-kind="missing_registration"
			>
				<h2 css={sectionTitleCss}>This connection is not registered</h2>
				<p role="alert" css={descriptionCss}>
					Kody has no registration for the app that sent you here. The app is
					reusing a saved sign-in that Kody no longer has, so trying again from
					this page will not help.
				</p>
				<ol css={listCss}>
					<li>
						In your app, log out of Kody and sign in again so it registers a new
						connection.
					</li>
					<li>
						If the app has no log out option, remove Kody from the app and add
						it again.
					</li>
				</ol>
				<p css={descriptionCss}>
					Using Codex? Run{' '}
					<code css={codeCss}>codex mcp logout {'<server>'}</code> then{' '}
					<code css={codeCss}>codex mcp login {'<server>'}</code>.
				</p>
				<ErrorAgentPromptButton prompt={prompt} />
			</section>
		)
	}
	const appName = oauthAuthorizeClientDisplayName(failure)
	const statusLabel = oauthAuthorizeFetchStatusLabel(failure)
	return (
		<section
			css={cardCss}
			data-testid="oauth-authorize-client-failure"
			data-failure-kind="metadata_fetch"
		>
			<h2 css={sectionTitleCss}>
				{appName === 'this app'
					? "Kody couldn't load this app's details"
					: `Kody couldn't load ${appName}'s details`}
			</h2>
			<p role="alert" css={descriptionCss}>
				Before you can approve, Kody downloads a short description of the app
				from the app's own website. That download failed. This is a problem on
				the app's side, not with your Kody account, and it is often temporary.
			</p>
			<dl css={failureDetailsCss}>
				<div css={detailItemCss}>
					<dt css={detailLabelCss}>Host</dt>
					<dd css={failureValueCss}>{failure.host}</dd>
				</div>
				<div css={detailItemCss}>
					<dt css={detailLabelCss}>Response</dt>
					<dd css={failureValueCss}>{statusLabel}</dd>
				</div>
			</dl>
			<div css={{ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' }}>
				<a
					href={props.retryHref}
					data-testid="oauth-authorize-retry"
					css={retryLinkCss}
				>
					Retry
				</a>
			</div>
			{failure.client === 'codex' ? (
				<div css={{ display: 'grid', gap: spacing.sm }}>
					<p css={descriptionCss}>
						Using the Codex CLI? Sign in with dynamic registration instead.
						Replace <code css={codeCss}>{'<server>'}</code> with the name from{' '}
						<code css={codeCss}>codex mcp list</code>:
					</p>
					<pre css={commandCss}>
						<code>{codexDcrLoginCommand}</code>
					</pre>
					<div css={{ justifySelf: 'start' }}>
						<CopyTextButton
							value={codexDcrLoginCommand}
							idleLabel="Copy command"
							variant="ghost"
							size="sm"
						/>
					</div>
					<p css={descriptionCss}>
						The Codex app has no such switch. Try again in a few minutes.
					</p>
				</div>
			) : failure.client === 'chatgpt' ? (
				<p css={descriptionCss}>
					ChatGPT has no way to sign in differently. Try again in a few minutes.
				</p>
			) : null}
			<ErrorAgentPromptButton prompt={prompt} />
		</section>
	)
}

function renderOauthAuthorizeGrant(input: {
	clientLabel: string
	scopes: ReadonlyArray<string>
	selectedOrgSlug: string | null
}) {
	return (
		<section data-testid="oauth-authorize-grant" css={cardCss}>
			<h2 css={sectionTitleCss}>
				{oauthAuthorizeGrantHeading(input.selectedOrgSlug)}
			</h2>
			<p css={descriptionCss}>
				Approving lets {input.clientLabel} use everything in this Kody
				{input.selectedOrgSlug
					? ` organization @${input.selectedOrgSlug}`
					: ' account'}
				: packages, memories, credentials, email, connected services, and
				anything else your assistant can do.
			</p>
			{input.scopes.length > 0 ? (
				<details
					data-testid="oauth-authorize-oidc-scopes"
					css={nativeDisclosureCss}
				>
					<summary>Identity claims on the token</summary>
					{/* nativeDisclosureCss grids each direct details child. */}
					<div>
						<p css={descriptionCss}>
							These OAuth scopes are identity claims. They do not limit what the
							assistant can do.
						</p>
						<p
							css={{
								...descriptionCss,
								display: 'flex',
								flexWrap: 'wrap',
								columnGap: spacing.md,
								rowGap: spacing.xs,
								alignItems: 'baseline',
							}}
						>
							{input.scopes.map((scope) => (
								<code key={scope}>{scope}</code>
							))}
						</p>
					</div>
				</details>
			) : null}
		</section>
	)
}

export function OAuthAuthorizeRoute({
	data,
	session,
	authProviders,
}: {
	data: OAuthAuthorizeLoaderData
	session: SessionInfo | null
	authProviders: PublicAuthConfig
}) {
	const requestResendVerification = useResendVerification()
	const fetchSessionInfo = useSessionInfo()
	const startSocialSignIn = useSocialSignIn()
	const submitDecisionRequest = useServerFn(submitOAuthDecision)
	const webauthnAuthenticationOptions = useServerFn(
		webauthnAuthenticationOptionsFn,
	)
	const webauthnAuthenticationVerify = useServerFn(
		webauthnAuthenticationVerifyFn,
	)
	const invalidatePages = usePageInvalidation(mutationResources, {
		refreshShell: true,
		refreshRoute: true,
	})
	const currentHref = useMatchedPageScope().pageLocation.href
	const [interactionSnapshot, , interactionActor] = useActor(oauthConsentState)
	const interaction = uiState<OAuthConsentState>(interactionSnapshot)
	const transition = useCallback(
		(event: Parameters<typeof interactionActor.send>[0]) =>
			sendUiEvent(interactionActor, event),
		[interactionActor],
	)
	const getInteraction = useCallback(
		() => uiState<OAuthConsentState>(interactionActor.getSnapshot()),
		[interactionActor],
	)
	const message =
		interaction.status === 'error'
			? { type: 'error' as const, text: interaction.message }
			: interaction.status === 'reset_complete'
				? { type: 'info' as const, text: interaction.message }
				: interaction.status === 'idle' && !data.ok
					? { type: 'error' as const, text: data.error }
					: null
	const info = data.ok ? data : null
	const status: OAuthAuthorizeStatus = data.ok ? 'ready' : 'error'
	const allowClientReset = !data.ok && data.allowClientReset
	const guestConnection =
		interaction.status === 'guest' ? interaction.connection : null
	const clientFailure =
		(interaction.status === 'error' ? interaction.clientFailure : null) ??
		(!data.ok ? (data.clientFailure ?? null) : null)
	const submittingDecision =
		interaction.status === 'deciding' || interaction.status === 'redirecting'
			? interaction.decision
			: null
	const resetCompleted = interaction.status === 'reset_complete'
	const [verificationSnapshot, , verificationActor] = useActor(
		emailVerificationState,
	)
	const verification = uiState<EmailVerificationState>(verificationSnapshot)
	const transitionVerification = useCallback(
		(event: Parameters<typeof verificationActor.send>[0]) =>
			sendUiEvent(verificationActor, event),
		[verificationActor],
	)

	const resendStatus =
		verification.status === 'sending' ? ('sending' as const) : ('idle' as const)
	const resendMessage = 'message' in verification ? verification.message : null
	const resendTone =
		verification.status === 'error' ? ('error' as const) : ('info' as const)
	const consentInteractive = useHydrated()
	const { turnstileSiteKey } = authProviders
	const formRef = useRef<HTMLFormElement>(null)
	const mounted = useRef(false)
	const [pickedOrgSlug, setPickedOrgSlug] = useState<
		string | null | undefined
	>()
	const requiredOrgSlug =
		info && 'requiredOrgSlug' in info ? (info.requiredOrgSlug ?? null) : null
	const displayedOrgSlug = requiredOrgSlug
		? requiredOrgSlug
		: pickedOrgSlug === undefined
			? (info?.selectedOrgSlug ?? null)
			: pickedOrgSlug
	useEffect(() => {
		mounted.current = true
		function pageshow(event: PageTransitionEvent) {
			const current = getInteraction()
			const busy =
				current.status === 'signing_in' || current.status === 'redirecting'
			if (
				busy &&
				resolveSignInStatusAfterPageshow(event.persisted, 'submitting') ===
					'idle'
			) {
				if (current.status === 'signing_in') current.controller.abort()
				transition({
					type: 'RESET',
					data: uiContext({ status: 'idle' }).data,
				} as Parameters<typeof interactionActor.send>[0])
				resetTurnstileWidgets()
			}
		}
		window.addEventListener('pageshow', pageshow)
		return () => {
			mounted.current = false
			const current = getInteraction()
			if (current.status === 'signing_in') current.controller.abort()
			window.removeEventListener('pageshow', pageshow)
		}
	}, [getInteraction, transition])
	useEffect(() => {
		if (turnstileSiteKey) void renderTurnstileWidgets(turnstileSiteKey)
	}, [turnstileSiteKey, session?.email, info?.requireCredentials])
	function protection() {
		const form = formRef.current
		return form
			? readPublicFormProtection(new FormData(form), form)
			: emptyPublicFormProtection()
	}
	function signInError(controller: AbortController, text: string | null) {
		const current = getInteraction()
		if (
			!mounted.current ||
			controller.signal.aborted ||
			current.status !== 'signing_in' ||
			current.controller !== controller
		)
			return
		if (text) {
			resetTurnstileWidgets()
			transition({
				...({
					type: 'RESPONSE_ERROR',
					data: uiContext({
						status: 'error',
						message: text,
						clientFailure: null,
					}).data,
				} as Parameters<typeof interactionActor.send>[0]),
				requestId: controller,
			})
		} else
			transition({
				...({
					type: 'RESET',
					data: uiContext({ status: 'idle' }).data,
				} as Parameters<typeof interactionActor.send>[0]),
				requestId: controller,
			})
	}
	async function signIn(provider?: string) {
		const controller = new AbortController()
		if (
			!transition({
				...({
					type: 'SIGN_IN',
					data: uiContext({ status: 'signing_in', controller }).data,
				} as Parameters<typeof interactionActor.send>[0]),
				requestId: controller,
			})
		)
			return
		const redirectTo = readOAuthResumeTarget()
		try {
			if (provider) {
				const error = await startSocialSignIn(
					provider,
					redirectTo,
					protection(),
					null,
					controller.signal,
				)
				if (error) signInError(controller, error)
				return
			}
			const options = await webauthnAuthenticationOptions({ data: {} })
			if (!options) return
			if (!options.successful || options?.ok !== true || !options.options) {
				signInError(controller, 'Unable to start passkey sign-in.')
				return
			}
			let response
			try {
				response = await startAuthentication({ optionsJSON: options.options })
			} catch {
				signInError(controller, null)
				return
			}
			controller.signal.throwIfAborted()
			const result = await webauthnAuthenticationVerify({
				data: { response, rememberMe: false, ...protection() },
			})
			controller.signal.throwIfAborted()
			if (!result) return
			if (!result.successful || result?.ok !== true) {
				signInError(
					controller,
					typeof result?.error === 'string'
						? result.error
						: 'Passkey sign-in failed.',
				)
				return
			}
			window.location.assign(
				resolvePasswordAuthRedirect({
					mode: 'login',
					requiresTwoFactor: result.requiresTwoFactor === true,
					redirectTo,
				}),
			)
		} catch {
			if (!controller.signal.aborted)
				signInError(controller, 'Network error. Please try again.')
		}
	}
	function readOAuthResumeTarget() {
		return normalizeRedirectTo(currentHref)
	}
	async function refreshSession() {
		const nextSession = await fetchSessionInfo()
		if (nextSession === undefined) return
		await invalidatePages()
		return nextSession
	}
	async function handleResendVerification() {
		if (
			!transitionVerification({
				type: 'RESEND',
				data: uiContext({ status: 'sending' }).data,
			} as Parameters<typeof verificationActor.send>[0])
		)
			return
		try {
			const result = await requestResendVerification(readOAuthResumeTarget())
			if (!mounted.current) return
			if (!result) {
				transitionVerification({
					type: 'CANCEL',
					data: uiContext({ status: 'idle' }).data,
				} as Parameters<typeof verificationActor.send>[0])
				return
			}
			if (result.ok) await refreshSession()
			if (mounted.current)
				transitionVerification({
					type:
						(result.ok ? 'success' : 'error') === 'success'
							? 'RESPONSE_OK'
							: 'RESPONSE_ERROR',
					data: { message: result.message },
				} as Parameters<typeof verificationActor.send>[0])
		} catch {
			if (mounted.current)
				transitionVerification({
					type: 'RESPONSE_ERROR',
					data: uiContext({
						status: 'error',
						message: 'Unable to resend the verification email.',
					}).data,
				} as Parameters<typeof verificationActor.send>[0])
		}
	}
	async function handleContinueAfterVerify() {
		if (
			!transitionVerification({
				type: 'CHECK',
				data: uiContext({ status: 'checking' }).data,
			} as Parameters<typeof verificationActor.send>[0])
		)
			return
		try {
			const nextSession = await refreshSession()
			if (!mounted.current) return
			if (nextSession === undefined) {
				transitionVerification({
					type: 'CANCEL',
					data: uiContext({ status: 'idle' }).data,
				} as Parameters<typeof verificationActor.send>[0])
				return
			}
			transitionVerification({
				type: 'RESPONSE_OK',
				data: uiContext({
					status: 'success',
					message: nextSession?.emailVerified
						? 'Email verified. You can approve the connection now.'
						: 'Still waiting on verification. Keep this page open, finish verification in another tab, then continue.',
				}).data,
			} as Parameters<typeof verificationActor.send>[0])
		} catch {
			if (mounted.current)
				transitionVerification({
					type: 'RESPONSE_ERROR',
					data: uiContext({
						status: 'error',
						message: 'Unable to check verification status. Try again.',
					}).data,
				} as Parameters<typeof verificationActor.send>[0])
		}
	}

	async function submitDecision(
		decision: OAuthAuthorizeDecision,
		form?: HTMLFormElement,
	) {
		const request = {}
		if (
			!transition({
				...({
					type: 'DECIDE',
					data: uiContext({ status: 'deciding', decision, request }).data,
				} as Parameters<typeof interactionActor.send>[0]),
				requestId: request,
			})
		)
			return

		try {
			const body = new URLSearchParams()
			body.set('decision', decision)
			if (decision === 'approve' && form) {
				const formData = new FormData(form)
				const org = String(formData.get('org') ?? '').trim()
				if (org) body.set('org', org)
				const email = String(formData.get('email') ?? '').trim()
				const password = String(formData.get('password') ?? '')
				if (email || password) {
					if (!email || !password) {
						transition({
							...({
								type: 'RESPONSE_ERROR',
								data: uiContext({
									status: 'error',
									message: 'Email and password are required.',
									clientFailure: null,
								}).data,
							} as Parameters<typeof interactionActor.send>[0]),
							requestId: request,
						})
						return
					}
					body.set('email', email)
					body.set('password', password)
					const protection = readPublicFormProtection(formData, form)
					body.set(honeypotFieldName, protection[honeypotFieldName])
					body.set(
						turnstileResponseFieldName,
						protection[turnstileResponseFieldName],
					)
				}
			}
			const payload = await submitDecisionRequest({
				data: {
					search: window.location.search,
					fields: Object.fromEntries(body),
				},
			})
			if (!payload) return
			const current = getInteraction()
			if (
				!mounted.current ||
				current.status !== 'deciding' ||
				current.request !== request
			)
				return
			if (!payload.successful) {
				resetTurnstileWidgets()
				const errorText =
					typeof payload?.error === 'string'
						? payload.error
						: 'Unable to complete authorization.'
				transition({
					...({
						type: 'RESPONSE_ERROR',
						data: uiContext({
							status: 'error',
							message: errorText,
							clientFailure: payload?.clientFailure ?? null,
						}).data,
					} as Parameters<typeof interactionActor.send>[0]),
					requestId: request,
				})
				if (payload?.code === 'email_verification_required') {
					await refreshSession()
				}
				return
			}
			if (payload.guest && payload.redirectTo) {
				transition({
					...({
						type: 'GUEST_CREATED',
						data: uiContext({
							status: 'guest',
							connection: {
								redirectTo: payload.redirectTo,
								claimUrl: payload.guest.claimUrl,
								expiresAt: payload.guest.expiresAt,
							},
						}).data,
					} as Parameters<typeof interactionActor.send>[0]),
					requestId: request,
				})
				return
			}
			if (payload?.redirectTo) {
				transition({
					...({
						type: 'REDIRECT',
						data: uiContext({ status: 'redirecting', decision }).data,
					} as Parameters<typeof interactionActor.send>[0]),
					requestId: request,
				})
				window.location.assign(payload.redirectTo)
				return
			}
			if (typeof payload?.message === 'string') {
				transition({
					...({
						type: 'CLIENT_RESET',
						data: uiContext({
							status: 'reset_complete',
							message: payload.message,
						}).data,
					} as Parameters<typeof interactionActor.send>[0]),
					requestId: request,
				})
				return
			}
			transition({
				...({
					type: 'RESPONSE_ERROR',
					data: uiContext({
						status: 'error',
						message: 'Missing redirect response.',
						clientFailure: null,
					}).data,
				} as Parameters<typeof interactionActor.send>[0]),
				requestId: request,
			})
		} catch {
			const current = getInteraction()
			if (
				!mounted.current ||
				current.status !== 'deciding' ||
				current.request !== request
			)
				return
			resetTurnstileWidgets()
			transition({
				...({
					type: 'RESPONSE_ERROR',
					data: uiContext({
						status: 'error',
						message: 'Network error. Please try again.',
						clientFailure: null,
					}).data,
				} as Parameters<typeof interactionActor.send>[0]),
				requestId: request,
			})
		} finally {
			const current = getInteraction()
			if (
				mounted.current &&
				current.status === 'deciding' &&
				current.request === request
			)
				transition({
					...({
						type: 'RESET',
						data: uiContext({ status: 'idle' }).data,
					} as Parameters<typeof interactionActor.send>[0]),
					requestId: request,
				})
		}
	}

	async function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		await submitDecision('approve', event.currentTarget)
	}

	const clientLabel =
		info?.client?.name === '@kodycodes/cli'
			? 'Kody CLI'
			: (info?.client?.name ?? 'Unknown client')
	const scopes = info?.scopes ?? []
	const sessionEmail = session?.email ?? ''
	const sessionDisplayName = getSessionDisplayName(session)
	const isSessionReady = true
	const isSessionLoading = false
	const requireCredentials = info?.requireCredentials === true
	const isLoggedIn =
		isSessionReady && Boolean(sessionEmail) && !requireCredentials
	const emailVerified = resolveAuthorizeEmailVerified({
		isSessionReady,
		sessionEmailVerified: session?.emailVerified,
		infoEmailVerified: info?.emailVerified,
	})
	const needsEmailVerification = isLoggedIn && !emailVerified
	const showResetClientCard = allowClientReset && !resetCompleted
	const showSignedOutChoices =
		!isLoggedIn && !sessionEmail && !resetCompleted && !clientFailure
	const showAuthorizeForm =
		!showSignedOutChoices &&
		!resetCompleted &&
		!needsEmailVerification &&
		status !== 'error' &&
		!clientFailure
	const hydrated = consentInteractive
	const consentForm = oauthAuthorizeConsentFormAttrs(currentHref)
	const orgField = oauthAuthorizeOrgField({
		orgs: info?.orgs ?? [],
		selectedOrgSlug: displayedOrgSlug,
		signedIn: isLoggedIn,
		requiredOrgSlug,
	})
	const actionsDisabled =
		orgField.kind === 'missing' ||
		interaction.status === 'signing_in' ||
		oauthAuthorizeActionsDisabled({
			hydrated,
			statusReady: status === 'ready',
			submitting: Boolean(submittingDecision),
			sessionLoading: isSessionLoading,
			needsEmailVerification,
		})
	const resetClientDisabled =
		Boolean(submittingDecision) || isSessionLoading || !isLoggedIn
	const formReady = hydrated && status === 'ready' && !isSessionLoading
	const accessLead = oauthAuthorizeAccessLead(status, clientLabel)
	const authorizeLabel = submittingDecision
		? 'Submitting...'
		: isLoggedIn
			? 'Approve connection'
			: 'Authorize'
	const approveAriaLabel = oauthAuthorizeApproveAriaLabel({
		hydrated,
		label: authorizeLabel,
	})
	const resetClientLabel =
		submittingDecision === 'reset-client'
			? 'Resetting this connection...'
			: 'Reset this connection'

	if (guestConnection) {
		return (
			<section css={pageCss}>
				<OAuthAuthorizeGuestConnected
					clientLabel={clientLabel}
					connection={guestConnection}
				/>
				<OAuthAuthorizeDisconnectFooter clientLabel={clientLabel} />
			</section>
		)
	}

	return (
		<section css={pageCss}>
			<OAuthAuthorizeConnectionHeader clientLabel={clientLabel} />
			{accessLead && status !== 'ready' ? (
				<p css={{ ...pageDescriptionCss, textAlign: 'center' }}>{accessLead}</p>
			) : null}
			{status === 'ready'
				? renderOauthAuthorizeGrant({
						clientLabel,
						scopes,
						selectedOrgSlug: displayedOrgSlug,
					})
				: null}
			{isLoggedIn ? (
				<section css={insetCardCss}>
					<p
						css={{
							margin: 0,
							fontWeight: typography.fontWeight.medium,
							color: colors.text,
						}}
					>
						Signed in as {sessionDisplayName}
					</p>
					<p css={descriptionCss}>
						{resetCompleted
							? 'Start the connection again from your client to continue with this account.'
							: needsEmailVerification
								? 'Verify your email before approving MCP access. Keep this page open so the original OAuth request is preserved.'
								: 'Approve to continue with this account.'}
					</p>
				</section>
			) : null}
			{needsEmailVerification ? (
				<EmailVerificationPrompt
					email={sessionEmail}
					description="MCP authorization cannot finish until this account email is verified. Resend the link here if needed. Keep this page open, verify in another tab, then continue without restarting the host connection."
					delivery={session?.emailVerificationDelivery ?? null}
					resendStatus={resendStatus}
					checking={verification.status === 'checking'}
					resendMessage={resendMessage}
					resendTone={resendTone}
					onResend={() => void handleResendVerification()}
					continueLabel="I've verified - continue"
					onContinue={() => void handleContinueAfterVerify()}
				/>
			) : null}
			{needsEmailVerification && !resetCompleted ? (
				<div css={{ marginBottom: spacing.md }}>
					<button
						type="button"
						data-testid="oauth-authorize-email-verify-deny"
						disabled={oauthAuthorizeEmailVerificationDenyDisabled({
							hydrated,
							submitting: Boolean(submittingDecision),
							sessionLoading: isSessionLoading,
						})}
						aria-label={oauthAuthorizeApproveAriaLabel({
							hydrated,
							label: 'Deny',
						})}
						onClick={() => submitDecision('deny')}
						css={secondaryButtonCss}
					>
						Deny
					</button>
				</div>
			) : null}
			{clientFailure ? (
				<OAuthAuthorizeClientFailureCard
					failure={clientFailure}
					retryHref={currentHref}
				/>
			) : null}
			{message && !clientFailure ? (
				<p
					role={message.type === 'error' ? 'alert' : undefined}
					css={getAlertCardCss(message.type)}
				>
					{message.text}
				</p>
			) : null}
			{message?.type === 'error' && !clientFailure ? (
				<ErrorAgentPromptButton
					prompt={buildMcpAuthorizeErrorAgentPrompt({
						errorMessage: message.text,
					})}
				/>
			) : null}
			{showResetClientCard ? (
				<section css={cardCss}>
					<p css={sectionTitleCss}>Reset stored connection</p>
					<p css={descriptionCss}>
						Revoke this account&apos;s grants for the client, then start the
						connection again. Shared client registrations used by other accounts
						stay in place.
					</p>
					{isLoggedIn ? (
						<button
							type="button"
							disabled={resetClientDisabled}
							onClick={() => submitDecision('reset-client')}
							css={dangerButtonCss}
						>
							{resetClientLabel}
						</button>
					) : isSessionReady ? (
						<p css={descriptionCss}>
							Sign in first, then reset this connection.
						</p>
					) : null}
				</section>
			) : null}
			{showSignedOutChoices ? (
				<OAuthAuthorizeSignedOutChoices
					clientLabel={clientLabel}
					loginHref={buildAuthLink('/login', readOAuthResumeTarget())}
					signupHref={buildAuthLink('/signup', readOAuthResumeTarget())}
					disabled={!formReady || Boolean(submittingDecision)}
					tryingOut={submittingDecision === 'guest'}
					onTryItOut={() => void submitDecision('guest')}
				/>
			) : null}
			{showAuthorizeForm ? (
				<form
					ref={formRef}
					method={consentForm.method}
					action={consentForm.action}
					data-testid="oauth-authorize-form"
					aria-busy={
						!hydrated ||
						interaction.status === 'deciding' ||
						interaction.status === 'redirecting' ||
						interaction.status === 'signing_in'
					}
					css={{
						...cardCss,
						opacity: formReady ? 1 : 0.7,
					}}
					onSubmit={handleSubmit}
				>
					{hydrated ? null : (
						<p role="status" css={visuallyHiddenCss}>
							Connection approval is available after the page finishes loading.
						</p>
					)}
					<input
						type="hidden"
						name="decision"
						value={oauthAuthorizeConsentDecision}
					/>
					<AuthorizeOrgField
						orgs={info?.orgs ?? []}
						selectedOrgSlug={displayedOrgSlug}
						signedIn={isLoggedIn}
						requiredOrgSlug={requiredOrgSlug}
						onChange={setPickedOrgSlug}
					/>
					<Honeypot />
					{!isLoggedIn && isSessionReady ? (
						<>
							{!sessionEmail ? (
								<p css={descriptionCss} data-testid="oauth-authorize-signup">
									New to Kody?{' '}
									<SiteLink
										href={buildAuthLink('/signup', readOAuthResumeTarget())}
									>
										Create an account
									</SiteLink>
									, then you'll come right back here to finish connecting.
								</p>
							) : null}
							<label css={fieldCss}>
								<span css={fieldLabelCss}>Email</span>
								<input
									type="email"
									name="email"
									required
									autoComplete="email"
									placeholder="you@example.com"
									disabled={actionsDisabled}
									css={inputCss}
								/>
							</label>
							<div css={fieldCss}>
								<label htmlFor="oauth-authorize-password" css={fieldLabelCss}>
									Password
								</label>
								<PasswordRevealInput
									id="oauth-authorize-password"
									name="password"
									required
									autoComplete="current-password"
									placeholder="Enter your password"
									disabled={actionsDisabled}
									css={inputCss}
								/>
							</div>
						</>
					) : null}
					{!isLoggedIn && isSessionReady ? (
						<>
							{authProviders.providers.length ? (
								<>
									<div role="separator" aria-label="or continue with">
										or continue with
									</div>
									<div
										css={{
											display: 'flex',
											gap: spacing.sm,
											justifyContent: 'center',
										}}
									>
										{authProviders.providers.map((provider) => (
											<button
												key={provider.id}
												type="button"
												disabled={actionsDisabled}
												aria-label={`Continue with ${provider.label}`}
												data-testid={`social-sign-in-${provider.id}`}
												css={secondaryButtonCss}
												onClick={() => void signIn(provider.id)}
											>
												<ProviderIcon providerId={provider.id} size="1.4rem" />
											</button>
										))}
									</div>
								</>
							) : null}
							<button
								type="button"
								disabled={actionsDisabled}
								data-testid="oauth-authorize-passkey"
								css={secondaryButtonCss}
								onClick={() => void signIn()}
							>
								Sign in with a passkey
							</button>
							{!sessionEmail ? (
								<p css={descriptionCss}>
									<SiteLink
										href={buildAuthLink('/login', readOAuthResumeTarget())}
										css={mutedLinkCss}
									>
										Use the full sign-in page
									</SiteLink>
								</p>
							) : null}
						</>
					) : null}
					{!isLoggedIn && turnstileSiteKey ? (
						<div className={turnstileWidgetClassName}></div>
					) : null}
					<div css={{ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' }}>
						<button
							type="submit"
							data-testid="oauth-authorize-approve"
							disabled={actionsDisabled}
							aria-label={approveAriaLabel}
							css={primaryButtonCss}
						>
							{authorizeLabel}
						</button>
						<button
							type="button"
							disabled={actionsDisabled}
							aria-label={oauthAuthorizeApproveAriaLabel({
								hydrated,
								label: 'Deny',
							})}
							onClick={() => submitDecision('deny')}
							css={secondaryButtonCss}
						>
							Deny
						</button>
					</div>
				</form>
			) : null}
			<OAuthAuthorizeDisconnectFooter clientLabel={clientLabel} />
		</section>
	)
}

const pageCss = {
	...stackedPageCss,
	maxWidth: '28rem',
	margin: '0 auto',
}

const codeCss = {
	fontFamily: typography.fontFamilyMono,
	fontSize: typography.fontSize.sm,
	overflowWrap: 'anywhere' as const,
}
const commandCss = {
	margin: 0,
	padding: spacing.sm,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
	color: colors.text,
	fontFamily: typography.fontFamilyMono,
	fontSize: typography.fontSize.sm,
	whiteSpace: 'pre-wrap' as const,
	overflowWrap: 'anywhere' as const,
}
const failureValueCss = {
	margin: 0,
	minWidth: 0,
	color: colors.text,
	overflowWrap: 'anywhere' as const,
}
const failureDetailsCss = {
	margin: 0,
	display: 'grid',
	gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
	gap: spacing.md,
}
const primaryButtonCss = getPrimaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})
const secondaryButtonCss = getSecondaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})
const retryLinkCss = {
	...primaryButtonCss,
	textDecoration: 'none',
	'&:hover': { textDecoration: 'none' },
}
const dangerButtonCss = getDangerButtonCss({
	size: 'lg',
	weight: 'semibold',
})

const mutationResources = [
	'loadAccountPage',
	'loadConnectionsPage',
	'loadOnboarding',
] as const
