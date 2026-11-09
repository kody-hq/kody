/** @jsxImportSource @emotion/react */
import { useStateMachine } from '#client/use-state-machine.ts'
import {
	passwordResetState,
	type PasswordResetState,
} from '#client/routes/password-reset-state.ts'
import type { StateOf } from '@kody-internal/shared/state-machine.ts'
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
import type { FormEvent } from 'react'
import { Honeypot } from '../components/honeypot-field.tsx'
import { usePublicAuthProtection } from '../components/public-auth-protection.ts'
import { SiteLink } from '../components/site-link.tsx'
import { useHydrated } from '../components/use-hydrated.ts'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'

type ResetStatus = StateOf<typeof passwordResetState>

export function ResetPasswordRoute() {
	const hydrated = useHydrated()
	const [flow, transition, getFlow] = useStateMachine<PasswordResetState>(
		passwordResetState,
		{ status: 'idle' },
	)
	const status = flow.status
	const message = 'message' in flow ? flow.message : null
	const turnstileSiteKey = usePublicAuthProtection()
	const search = useMatchedPageScope().pageLocation.searchStr

	function setState(
		nextStatus: ResetStatus,
		nextMessage: string | null = null,
	) {
		const accepted =
			nextStatus === 'error' || nextStatus === 'success'
				? transition({ status: nextStatus, message: nextMessage ?? '' })
				: transition({ status: nextStatus })
		if (accepted && nextStatus === 'error') resetTurnstileWidgets()
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
			setState('error', 'Email is required.')
			return
		}

		if (!setState('submitting')) return
		try {
			const payload = await requestWebsitePasswordReset({
				data: { email, ...protection },
			})
			if (!payload.successful) {
				const errorMessage =
					typeof payload?.error === 'string'
						? payload.error
						: 'Unable to request a reset.'
				setState('error', errorMessage)
				return
			}
			setState(
				'success',
				payload?.message ?? 'Check your inbox for a reset link.',
			)
		} catch {
			setState('error', 'Network error. Please try again.')
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
			setState('error', 'Password is required.')
			return
		}

		if (!setState('submitting')) return
		try {
			const payload = await confirmWebsitePasswordReset({
				data: { token, password, ...protection },
			})
			if (!payload.successful) {
				const errorMessage =
					typeof payload?.error === 'string'
						? payload.error
						: 'Unable to reset password.'
				setState('error', errorMessage)
				return
			}
			setState('success', 'Password updated. You can sign in.')
		} catch {
			setState('error', 'Network error. Please try again.')
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
