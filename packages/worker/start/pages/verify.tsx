/** @jsxImportSource @emotion/react */
import { uiState, uiContext, sendUiEvent } from '#client/ui-actor.ts'
import { useCallback, useState, type FormEvent } from 'react'
import { useActor } from '@xstate/react'
import {
	twoFactorVerifyState,
	type TwoFactorVerifyState,
} from '#client/routes/two-factor-verify-state.ts'
import {
	readPublicFormProtection,
	resetTurnstileWidgets,
	turnstileWidgetClassName,
} from '#client/public-form-protection.ts'
import { useServerFn } from '@tanstack/react-start'
import { verifyWebsiteTwoFactor } from '#start/server/auth-mutations'
import {
	normalizeRedirectTo,
	resolvePostAuthLandingPath,
} from '#universal/safe-redirect.ts'
import {
	cardCss,
	fieldCss,
	fieldLabelCss,
	getPrimaryButtonCss,
	inputCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { authFormErrorMessage } from '#universal/auth-form-errors.ts'
import { packageAppDeviceSignInTarget } from '#universal/package-app-oauth-paths.ts'
import { AuthFormFallback } from '../components/auth-form-fallback.tsx'
import {
	DeviceSignInOption,
	HumanCheckHelp,
} from '../components/device-sign-in-option.tsx'
import { Honeypot } from '../components/honeypot-field.tsx'
import { usePublicAuthProtection } from '../components/public-auth-protection.ts'
import { SiteLink } from '../components/site-link.tsx'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
function buildLoginHref(redirectTo: string | null) {
	return redirectTo
		? `/login?redirectTo=${encodeURIComponent(redirectTo)}`
		: '/login'
}

export function VerifyRoute() {
	const verifyTwoFactor = useServerFn(verifyWebsiteTwoFactor)
	const [flowSnapshot, , flowActor] = useActor(twoFactorVerifyState)
	const flow = uiState<TwoFactorVerifyState>(flowSnapshot)
	const transition = useCallback(
		(event: Parameters<typeof flowActor.send>[0]) =>
			sendUiEvent(flowActor, event),
		[flowActor],
	)
	const getFlow = useCallback(
		() => uiState<TwoFactorVerifyState>(flowActor.getSnapshot()),
		[flowActor],
	)
	const status = flow.status
	const message = 'message' in flow ? flow.message : null
	const [formErrorDismissed, setFormErrorDismissed] = useState(false)
	const turnstileSiteKey = usePublicAuthProtection()
	const search = useMatchedPageScope().pageLocation.searchStr
	const deviceSignInTarget = packageAppDeviceSignInTarget(
		normalizeRedirectTo(new URLSearchParams(search).get('redirectTo')),
	)
	const formErrorMessage =
		status === 'idle' && !formErrorDismissed
			? authFormErrorMessage(new URLSearchParams(search).get('formError'), {
					deviceSignIn: Boolean(deviceSignInTarget),
				})
			: null

	function getRedirectTo() {
		const params = new URLSearchParams(search)
		return normalizeRedirectTo(params.get('redirectTo'))
	}

	async function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (getFlow().status === 'submitting') return
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		const form = event.currentTarget

		const formData = new FormData(form)
		const code = String(formData.get('code') ?? '').trim()
		const protection = readPublicFormProtection(formData, form)
		if (!code) {
			transition({
				type: flowActor.getSnapshot().matches('submitting')
					? 'RESPONSE_ERROR'
					: 'VALIDATION_ERROR',
				data: uiContext({
					status: 'error',
					message: 'Enter the 6-digit code from your authenticator app.',
				}).data,
			} as Parameters<typeof flowActor.send>[0])
			return
		}

		setFormErrorDismissed(true)
		if (
			!transition({
				type: 'SUBMIT',
				data: uiContext({ status: 'submitting' }).data,
			} as Parameters<typeof flowActor.send>[0])
		)
			return

		try {
			const payload = await verifyTwoFactor({
				data: { code, ...protection },
			})
			if (!payload) return
			if (!payload.successful || !payload.ok) {
				if (payload?.code === 'expired') {
					window.location.assign(buildLoginHref(getRedirectTo()))
					return
				}
				transition({
					type: flowActor.getSnapshot().matches('submitting')
						? 'RESPONSE_ERROR'
						: 'VALIDATION_ERROR',
					data: uiContext({
						status: 'error',
						message:
							typeof payload?.error === 'string'
								? payload.error
								: 'Unable to verify the code.',
					}).data,
				} as Parameters<typeof flowActor.send>[0])
				resetTurnstileWidgets()
				return
			}

			window.location.assign(
				resolvePostAuthLandingPath(getRedirectTo()) ?? '/account',
			)
		} catch {
			transition({
				type: flowActor.getSnapshot().matches('submitting')
					? 'RESPONSE_ERROR'
					: 'VALIDATION_ERROR',
				data: uiContext({
					status: 'error',
					message: 'Network error. Please try again.',
				}).data,
			} as Parameters<typeof flowActor.send>[0])
			resetTurnstileWidgets()
		}
	}

	const isSubmitting = status === 'submitting'

	return (
		<section css={pageCss}>
			<header css={pageHeaderCss}>
				<h1 css={pageTitleCss}>Two-factor authentication</h1>
				<p css={pageDescriptionCss}>
					Enter the 6-digit code from your authenticator app to finish signing
					in.
				</p>
			</header>
			<form
				method="post"
				aria-busy={isSubmitting}
				css={cardCss}
				onSubmit={handleSubmit}
			>
				<Honeypot />
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Verification code</span>
					<input
						type="text"
						name="code"
						required
						autoFocus
						inputMode="numeric"
						autoComplete="one-time-code"
						pattern="[0-9]{6}"
						placeholder="123456"
						onChange={() => setFormErrorDismissed(true)}
						css={inputCss}
					/>
				</label>
				{turnstileSiteKey ? (
					<div
						className={turnstileWidgetClassName}
						data-sitekey={turnstileSiteKey}
					></div>
				) : null}
				<button type="submit" disabled={isSubmitting} css={primaryButtonCss}>
					{isSubmitting ? 'Verifying...' : 'Verify'}
				</button>
				{(message ?? formErrorMessage) ? (
					<p
						aria-live="polite"
						css={{
							color: colors.error,
							fontSize: typography.fontSize.sm,
						}}
					>
						{message ?? formErrorMessage}
					</p>
				) : null}
			</form>
			{turnstileSiteKey ? (
				<HumanCheckHelp deviceSignIn={Boolean(deviceSignInTarget)} />
			) : null}
			{deviceSignInTarget ? (
				<DeviceSignInOption target={deviceSignInTarget} />
			) : null}
			<AuthFormFallback
				turnstileSiteKey={turnstileSiteKey}
				note={
					turnstileSiteKey
						? deviceSignInTarget
							? 'JavaScript is off. The two-factor step needs a quick human check that uses JavaScript, so use Sign in on another device, or turn JavaScript on.'
							: 'JavaScript is off. The two-factor step needs a quick human check that uses JavaScript, so turn JavaScript on to finish signing in.'
						: 'JavaScript is off, so this form submits as a plain page. Enter your code and press Verify.'
				}
			/>
			<div css={{ display: 'grid', gap: spacing.sm }}>
				<SiteLink href={buildLoginHref(getRedirectTo())} css={mutedLinkCss}>
					Back to login
				</SiteLink>
			</div>
		</section>
	)
}

const pageCss = {
	...stackedPageCss,
	maxWidth: '28rem',
	margin: '0 auto',
}

const primaryButtonCss = getPrimaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})
