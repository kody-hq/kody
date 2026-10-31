/** @jsxImportSource @emotion/react */
import { useServerFn } from '@tanstack/react-start'
import { handlePermanenceConfirmMessage } from '@kody-internal/shared/handle-permanence.ts'
import { completeOauthPendingSignup } from '#start/server/auth-mutations'
import { type CSSObject } from '@emotion/react'
import { colors } from '#universal/styles/tokens.ts'
import {
	getPillButtonCss,
	getSwapLabelCss,
	hoverMq,
} from '#universal/styles/style-primitives.ts'
import {
	useEffect,
	useId,
	useRef,
	useState,
	type CSSProperties,
	type FormEvent,
} from 'react'
import { buildAuthLink } from '#client/auth-links.ts'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import { SiteLink } from '../components/site-link.tsx'
import { useHydrated } from '../components/use-hydrated.ts'
import {
	UsernameChoiceField,
	type UsernameAvailabilityView,
} from '../components/username-choice-field.tsx'
import {
	formMessageCss,
	renderLoginVisualPanel,
	renderMobileBrand,
} from './login-sections.tsx'

export function SignupChooseUsernamePage(props: {
	csrf: string
	suggestedUsername: string
	email: string
	provider: string
	providerUsername: string | null
	displayName: string | null
	redirectTo: string | null
}) {
	const completeSignup = useServerFn(completeOauthPendingSignup)
	const signupRestartHref = buildAuthLink(
		'/signup',
		normalizeRedirectTo(props.redirectTo),
	)
	const hydrated = useHydrated()
	const handleId = useId()
	const lifecycle = useRef<AbortController | null>(null)
	useEffect(() => {
		const controller = new AbortController()
		lifecycle.current = controller
		return () => controller.abort()
	}, [])
	const [username, setUsername] = useState(props.suggestedUsername)
	const [availability, setAvailability] = useState<UsernameAvailabilityView>({
		status: 'idle',
	})
	const [confirmedUsername, setConfirmedUsername] = useState<string | null>(
		null,
	)
	const [status, setStatus] = useState<'idle' | 'submitting' | 'error'>('idle')
	const [message, setMessage] = useState<string | null>(null)

	const confirming =
		confirmedUsername !== null &&
		confirmedUsername === username.trim().toLowerCase()
	const isSubmitting = status === 'submitting'
	const submitLabel = confirming ? 'Yes, create account' : 'Continue'
	const canSubmit =
		availability.status !== 'idle' &&
		availability.status !== 'taken' &&
		availability.status !== 'reserved' &&
		availability.status !== 'invalid' &&
		(!confirming || availability.status !== 'checking')

	async function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		const nextUsername = username.trim().toLowerCase()
		if (!nextUsername) {
			setStatus('error')
			setMessage('Username is required.')
			return
		}
		if (
			availability.status === 'taken' ||
			availability.status === 'reserved' ||
			availability.status === 'invalid'
		) {
			setStatus('error')
			setMessage(availability.reason ?? 'That username cannot be used.')
			return
		}
		if (confirmedUsername !== nextUsername) {
			setConfirmedUsername(nextUsername)
			setStatus('idle')
			setMessage(handlePermanenceConfirmMessage(nextUsername))
			return
		}
		if (availability.status === 'checking') {
			setStatus('error')
			setMessage('Wait for the availability check to finish.')
			return
		}

		setStatus('submitting')
		setMessage(null)
		try {
			const payload = await completeSignup({
				signal: lifecycle.current?.signal,
				data: {
					username: nextUsername,
					csrf: props.csrf,
				},
			})
			if (!payload) return
			if (!payload.successful || payload.ok !== true) {
				setStatus('error')
				setMessage(
					typeof payload.error === 'string'
						? payload.error
						: 'Unable to create your account.',
				)
				if (
					payload.code === 'pending_expired' ||
					payload.code === 'pending_csrf'
				) {
					window.location.assign(signupRestartHref)
				}
				return
			}
			window.location.assign(
				typeof payload.redirectTo === 'string'
					? payload.redirectTo
					: '/onboarding',
			)
		} catch {
			setStatus('error')
			setMessage('Network error. Please try again.')
		}
	}

	return (
		<div css={authLayoutCss}>
			{renderLoginVisualPanel()}
			<div css={authPanelCss}>
				{renderMobileBrand()}
				<div css={authCardCss}>
					<header
						data-rise
						style={{ '--rise': '0' } as CSSProperties}
						css={authHeadCss}
					>
						<h1>Choose your username</h1>
						<p>
							This is also your personal organization handle. Pick carefully:
							you can't change it later.
						</p>
						<p data-testid="signup-org-hint">
							Using Kody for a business? You can create an organization with its
							own handle anytime.
						</p>
					</header>

					<form
						data-rise
						style={{ '--rise': '1' } as CSSProperties}
						css={formCss}
						onSubmit={handleSubmit}
						noValidate
					>
						<input type="hidden" name="csrf" value={props.csrf} />
						<UsernameChoiceField
							value={username}
							onChange={(value) => {
								setUsername(value)
								setConfirmedUsername(null)
								// Clear confirm and error copy so the form never still
								// claims the previous handle is about to be locked.
								setStatus('idle')
								setMessage(null)
							}}
							onAvailabilityChange={setAvailability}
							seeds={{
								email: props.email,
								providerUsername: props.providerUsername,
								displayName: props.displayName,
							}}
							autoFocus
							inputId={`${handleId}-username`}
							confirming={confirming}
							disabled={isSubmitting}
							invalid={status === 'error'}
						/>

						{message ? (
							<p
								aria-live="polite"
								data-tone={status === 'error' ? 'error' : 'info'}
								css={formMessageCss}
							>
								{message}
							</p>
						) : null}

						<button
							type="submit"
							disabled={!hydrated || isSubmitting || !canSubmit}
							css={authSubmitCss}
						>
							<span
								data-swap-label
								data-active={isSubmitting ? undefined : true}
								aria-hidden={isSubmitting ? 'true' : undefined}
							>
								{submitLabel}
							</span>
							<span
								data-swap-label
								data-active={isSubmitting ? true : undefined}
								aria-hidden={isSubmitting ? undefined : 'true'}
							>
								Creating account…
							</span>
						</button>
					</form>

					<footer
						data-rise
						style={{ '--rise': '2' } as CSSProperties}
						css={authFootCss}
					>
						<p>
							Wrong account?{' '}
							<SiteLink href={signupRestartHref}>Start over</SiteLink>.
						</p>
					</footer>
				</div>
				<div css={authCornerCss}>
					<SiteLink href="/">&larr; Back to Kody</SiteLink>
				</div>
			</div>
		</div>
	)
}

const mobileMq = '@media (max-width: 900px)'

const authLayoutCss: CSSObject = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
	width: '100%',
	[mobileMq]: {
		gridTemplateColumns: '1fr',
	},
}

const authPanelCss: CSSObject = {
	display: 'flex',
	flexDirection: 'column',
	justifyContent: 'center',
	gap: '2rem',
	padding: 'clamp(1.5rem, 4vw, 3rem)',
	position: 'relative',
	backgroundColor: colors.surface,
	[mobileMq]: {
		justifyContent: 'flex-start',
		paddingTop: 'clamp(1.75rem, 6vw, 2.75rem)',
	},
}

const authCardCss: CSSObject = {
	width: 'min(100%, 400px)',
	marginInline: 'auto',
	display: 'flex',
	flexDirection: 'column',
	gap: '1.7rem',
}

const authHeadCss: CSSObject = {
	'& h1': {
		margin: 0,
		fontSize: 'clamp(1.9rem, 3vw, 2.3rem)',
		fontWeight: 760,
		letterSpacing: '-0.025em',
		lineHeight: 1.05,
	},
	'& p': {
		margin: '0.5rem 0 0',
		color: colors.textMuted,
	},
	[mobileMq]: {
		textAlign: 'center',
	},
}

const formCss: CSSObject = {
	display: 'flex',
	flexDirection: 'column',
	gap: '1.1rem',
}

const authSubmitCss = [
	getPillButtonCss(),
	getSwapLabelCss(),
	{
		marginTop: '0.3rem',
		'&:disabled, &[aria-disabled="true"]': {
			opacity: 0.7,
			cursor: 'progress',
			transform: 'none',
		},
		[hoverMq]: {
			'&[aria-disabled="true"]:hover, &[aria-disabled="true"]:active': {
				transform: 'none',
				boxShadow: 'none',
			},
		},
	},
]

const authFootCss: CSSObject = {
	borderTop: `1px solid ${colors.border}`,
	paddingTop: '1.3rem',
	'& p': {
		margin: 0,
		fontSize: '0.95rem',
		color: colors.textMuted,
		textAlign: 'center',
	},
	'& a': {
		color: colors.primaryText,
		textDecorationThickness: '1.5px',
		textUnderlineOffset: '3px',
	},
}

const authCornerCss: CSSObject = {
	position: 'absolute',
	top: 'clamp(1rem, 2.5vw, 1.8rem)',
	right: 'clamp(1rem, 2.5vw, 1.8rem)',
	fontSize: '0.92rem',
	'& > a': {
		color: colors.textMuted,
		textDecoration: 'none',
	},
	'& > a:hover': { color: colors.text },
	[mobileMq]: { display: 'none' },
}
