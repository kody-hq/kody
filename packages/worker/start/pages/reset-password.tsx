/** @jsxImportSource @emotion/react */
import { uiState, uiContext, sendUiEvent } from '#client/ui-actor.ts'
import { useCallback, type FormEvent } from 'react'
import { useMachine } from '@xstate/react'
import {
	passwordResetState,
	type PasswordResetState,
} from '#client/routes/password-reset-state.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import {
	readPublicFormProtection,
	resetTurnstileWidgets,
	turnstileWidgetClassName,
} from '#client/public-form-protection.ts'
import {
	confirmWebsitePasswordReset,
	requestWebsitePasswordReset,
} from '#start/server/auth-mutations'
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
	primaryLinkCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { Honeypot } from '../components/honeypot-field.tsx'
import { usePublicAuthProtection } from '../components/public-auth-protection.ts'
import { SiteLink } from '../components/site-link.tsx'
import { useHydrated } from '../components/use-hydrated.ts'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
export function ResetPasswordRoute() {
	const hydrated = useHydrated()
	const [flowSnapshot, , flowActor] = useMachine(passwordResetState, {
		snapshot: (() => {
			const initialView = { status: 'idle' }
			return passwordResetState.resolveState({
				value: initialView.status,
				context: uiContext(initialView),
			})
		})(),
	})
	const flow = uiState<PasswordResetState>(flowSnapshot)
	const transition = useCallback(
		(event: Parameters<typeof flowActor.send>[0]) =>
			sendUiEvent(flowActor, event),
		[flowActor],
	)
	const getFlow = useCallback(
		() => uiState<PasswordResetState>(flowActor.getSnapshot()),
		[flowActor],
	)
	const status = flow.status
	const message = 'message' in flow ? flow.message : null
	const turnstileSiteKey = usePublicAuthProtection()
	const search = useMatchedPageScope().pageLocation.searchStr

	function sendFormEvent(event: Parameters<typeof flowActor.send>[0]) {
		const accepted = transition(event)
		if (
			accepted &&
			(event.type === 'RESPONSE_ERROR' || event.type === 'VALIDATION_ERROR')
		)
			resetTurnstileWidgets()
		return accepted
	}

	async function submitResetRequest(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (getFlow().status === 'submitting') return
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		const form = event.currentTarget

		const formData = new FormData(form)
		const email = String(formData.get('email') ?? '').trim()
		const protection = readPublicFormProtection(formData, form)
		if (!email) {
			sendFormEvent({
				type: 'VALIDATION_ERROR',
				data: { message: 'Email is required.' },
			})
			return
		}

		if (!sendFormEvent({ type: 'SUBMIT', data: {} })) return
		try {
			const payload = await requestWebsitePasswordReset({
				data: { email, ...protection },
			})
			if (!payload.successful) {
				const errorMessage =
					typeof payload?.error === 'string'
						? payload.error
						: 'Unable to request a reset.'
				sendFormEvent({
					type: 'RESPONSE_ERROR',
					data: { message: errorMessage },
				})
				return
			}
			sendFormEvent({
				type: 'RESPONSE_OK',
				data: {
					message: payload?.message ?? 'Check your inbox for a reset link.',
				},
			})
		} catch {
			sendFormEvent({
				type: 'RESPONSE_ERROR',
				data: { message: 'Network error. Please try again.' },
			})
		}
	}

	async function submitResetConfirm(
		event: FormEvent<HTMLFormElement>,
		token: string,
	) {
		event.preventDefault()
		if (getFlow().status === 'submitting') return
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		const form = event.currentTarget

		const formData = new FormData(form)
		const password = String(formData.get('password') ?? '')
		const protection = readPublicFormProtection(formData, form)
		if (!password) {
			sendFormEvent({
				type: 'VALIDATION_ERROR',
				data: { message: 'Password is required.' },
			})
			return
		}

		if (!sendFormEvent({ type: 'SUBMIT', data: {} })) return
		try {
			const payload = await confirmWebsitePasswordReset({
				data: { token, password, ...protection },
			})
			if (!payload.successful) {
				const errorMessage =
					typeof payload?.error === 'string'
						? payload.error
						: 'Unable to reset password.'
				sendFormEvent({
					type: 'RESPONSE_ERROR',
					data: { message: errorMessage },
				})
				return
			}
			sendFormEvent({
				type: 'RESPONSE_OK',
				data: { message: 'Password updated. You can sign in.' },
			})
		} catch {
			sendFormEvent({
				type: 'RESPONSE_ERROR',
				data: { message: 'Network error. Please try again.' },
			})
		}
	}

	const searchParams = new URLSearchParams(search)
	const token = String(searchParams.get('token') ?? '').trim()
	const mode = token ? 'confirm' : 'request'
	const isSubmitting = status === 'submitting'
	const title =
		mode === 'confirm' ? 'Choose a new password' : 'Reset your password'
	const description =
		mode === 'confirm'
			? 'Enter a new password for your account.'
			: 'We will send a reset link to your email.'

	return (
		<section css={pageCss}>
			<header css={pageHeaderCss}>
				<h1 css={pageTitleCss}>{title}</h1>
				<p css={pageDescriptionCss}>{description}</p>
			</header>
			<form
				aria-busy={isSubmitting}
				method="post"
				{...passwordManagerIgnoreProps}
				css={cardCss}
				onSubmit={(event) =>
					mode === 'confirm'
						? submitResetConfirm(event, token)
						: submitResetRequest(event)
				}
			>
				<Honeypot />
				{mode === 'confirm' ? (
					<label css={fieldCss}>
						<span css={fieldLabelCss}>New password</span>
						<input
							type="password"
							name="password"
							required
							{...passwordManagerIgnoreProps}
							placeholder="At least 8 characters"
							disabled={!hydrated || isSubmitting}
							css={inputCss}
						/>
					</label>
				) : (
					<label css={fieldCss}>
						<span css={fieldLabelCss}>Email</span>
						<input
							type="email"
							name="email"
							required
							autoComplete="email"
							placeholder="you@example.com"
							disabled={!hydrated || isSubmitting}
							css={inputCss}
						/>
					</label>
				)}
				{turnstileSiteKey ? (
					<div className={turnstileWidgetClassName}></div>
				) : null}
				<button
					type="submit"
					disabled={!hydrated || isSubmitting}
					css={primaryButtonCss}
				>
					{isSubmitting
						? 'Submitting...'
						: mode === 'confirm'
							? 'Update password'
							: 'Send reset link'}
				</button>
				{message ? (
					<p
						aria-live="polite"
						css={{
							color: status === 'error' ? colors.error : colors.text,
							fontSize: typography.fontSize.sm,
						}}
					>
						{message}
					</p>
				) : null}
			</form>
			<div css={{ display: 'grid', gap: spacing.sm }}>
				<SiteLink href="/login" css={primaryLinkCss}>
					Back to sign in
				</SiteLink>
				<SiteLink href="/" css={mutedLinkCss}>
					Back home
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
