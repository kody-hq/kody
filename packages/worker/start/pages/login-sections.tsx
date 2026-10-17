/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
import {
	handlePermanentNote,
	handleUrlPreview,
} from '@kody-internal/shared/handle-permanence.ts'
import { handleFormatHint } from '@kody-internal/shared/handle-rules.ts'
import { minPasswordLength } from '@kody-internal/shared/password-policy.ts'
import { permanentHandleInputProps } from '#client/handle-field.ts'
import { PasswordRevealInput } from '../components/password-reveal-input.tsx'
import { type CSSObject } from '@emotion/react'
import { type CSSProperties, type FormEvent } from 'react'
import { SiteLink } from '../components/site-link.tsx'
import {
	fieldErrorProps,
	invalidFieldsForMessage,
} from '#client/form-error-fields.ts'
import { HeroStage } from '../components/hero-stage.tsx'
import { honeypotFieldName } from '#universal/public-form-protection.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { renderIcon } from '../components/icon.tsx'
import { turnstileWidgetClassName } from '#client/public-form-protection.ts'
import { colors, transitions, typography } from '#universal/styles/tokens.ts'
import {
	authFieldCss,
	authFieldLabelCss,
	authFieldLabelRowCss,
	getAuthInputCss,
	getGhostButtonCss,
	getLanternGlowCss,
	getPillButtonCss,
	getSwapLabelCss,
	hoverMq,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import { type AuthStatus } from './login.tsx'

const motionOk = '@media (prefers-reduced-motion: no-preference)'
const mobileMq = '@media (max-width: 900px)'

function renderBrand(
	extraCss: CSSObject,
	options: { decorative?: boolean } = {},
) {
	return (
		<SiteLink
			href="/"
			// Inside the aria-hidden visual panel the brand is decorative;
			// keeping it out of the tab order avoids focusing content that
			// assistive tech cannot see.
			tabIndex={options.decorative ? -1 : undefined}
			css={extraCss}
		>
			<img
				src={publicAsset('/images/kody-mark.png')}
				alt=""
				width={34}
				height={34}
			/>
			<span>Kody</span>
		</SiteLink>
	)
}

export function renderMobileBrand() {
	return renderBrand(authBrandMobileCss)
}

export function renderLoginVisualPanel() {
	return (
		<aside data-parallax-scope aria-hidden="true" css={authVisualCss}>
			{renderBrand(authBrandCss, { decorative: true })}
			<div css={authSceneCss}>
				<div css={authStageWrapCss}>
					<HeroStage size="auth" alt="" />
				</div>
				<p css={authGreetingCss}>Good to see you.</p>
				<p css={authGreetingSubCss}>
					Your packages, jobs, and memory: right where you left them.
				</p>
			</div>
			<p css={authFactCss}>
				Fully isolated per user. Your capabilities are yours alone.
			</p>
		</aside>
	)
}

// Only edits to text-like fields clear a submit error; toggling the
// Remember me checkbox does not change the credentials that failed.
function isTextEntryTarget(target: EventTarget | null) {
	if (target instanceof HTMLTextAreaElement) return true
	if (!(target instanceof HTMLInputElement)) return false
	return target.type !== 'checkbox' && target.type !== 'radio'
}

function renderStatusMessage(
	handleId: string,
	status: AuthStatus,
	message: string | null,
) {
	return (
		<>
			{/*
			 * A live region only announces text that changes while the
			 * region is already in the accessibility tree, so the announcer
			 * stays mounted for the life of the form. Errors use `alert`
			 * (assertive); everything else stays `status`. It is out of
			 * flow, so it costs no flex gap while empty.
			 */}
			<p
				id={`${handleId}-form-status`}
				role={status === 'error' ? 'alert' : 'status'}
				css={visuallyHiddenCss}
			>
				{message ?? ''}
			</p>
			{/*
			 * The visible copy is hidden from assistive tech so the same
			 * sentence is not announced twice, and stays conditional so an
			 * empty message adds no gap to the form.
			 */}
			<p
				aria-hidden="true"
				data-tone={status === 'error' ? 'error' : 'info'}
				hidden={message ? undefined : true}
				css={formMessageCss}
			>
				{message ?? ''}
			</p>
		</>
	)
}

export type LoginFormSharedProps = {
	handleId: string
	turnstileSiteKey: string | null
	status: AuthStatus
	message: string | null
	isSubmitting: boolean
	isInteractive: boolean
	onFieldEdit: () => void
}

export function AuthForm(
	props: LoginFormSharedProps & {
		isSignup: boolean
		signupUsername: string
		onSignupUsernameInput: (value: string) => void
		onSignupUsernameBlur?: (value: string) => void
		submitLabel: string
		submitBusyLabel: string
		onSubmit: (event: FormEvent<HTMLFormElement>) => void
		onPasskeySignIn: () => void
	},
) {
	const usernameNoteId = `${props.handleId}-username-note`
	const statusId = `${props.handleId}-form-status`
	const invalidFields = invalidFieldsForMessage(props.status, props.message, [
		'email',
		'password',
	])
	return (
		<form
			key="authentication"
			data-public-auth-form
			data-rise
			method="post"
			noValidate
			style={{ '--rise': '1' } as CSSProperties}
			css={authFormCss}
			onSubmit={props.onSubmit}
			onInput={(event) => {
				if (isTextEntryTarget(event.target)) props.onFieldEdit()
			}}
		>
			<input
				type="text"
				name={honeypotFieldName}
				tabIndex={-1}
				aria-hidden="true"
				readOnly
				{...passwordManagerIgnoreProps}
				css={{
					position: 'absolute',
					left: '-10000px',
					width: '1px',
					height: '1px',
					overflow: 'hidden',
				}}
			/>
			{props.isSignup ? (
				<div css={authFieldCss}>
					<label htmlFor={`${props.handleId}-username`} css={authFieldLabelCss}>
						Username
					</label>
					<input
						id={`${props.handleId}-username`}
						type="text"
						name="username"
						required
						autoFocus
						autoComplete="username"
						placeholder="kent"
						data-field-ring
						{...permanentHandleInputProps({ caseInsensitivePattern: true })}
						{...fieldErrorProps('username', invalidFields, statusId)}
						onBlur={(event) =>
							props.onSignupUsernameBlur?.(event.currentTarget.value)
						}
						aria-describedby={[
							usernameNoteId,
							fieldErrorProps('username', invalidFields, statusId)[
								'aria-describedby'
							],
						]
							.filter(Boolean)
							.join(' ')}
						onInput={(event) =>
							props.onSignupUsernameInput(event.currentTarget.value)
						}
						css={authInputCss}
					/>
					<p
						id={usernameNoteId}
						css={{
							margin: 0,
							fontSize: typography.fontSize.sm,
							color: colors.textMuted,
						}}
					>
						{handleFormatHint} {handlePermanentNote} Your profile URL will be{' '}
						<strong>
							{handleUrlPreview(
								props.signupUsername.trim().toLowerCase() || 'your-username',
							)}
						</strong>
						.
					</p>
				</div>
			) : null}
			<div css={authFieldCss}>
				<label htmlFor={`${props.handleId}-email`} css={authFieldLabelCss}>
					Email
				</label>
				<input
					id={`${props.handleId}-email`}
					type="email"
					name="email"
					required
					autoFocus={!props.isSignup}
					// Login uses username so vault entries that store the email
					// in the username field (1Password's default) can autofill.
					// Signup email stays email; the username field above is the
					// Kody handle.
					autoComplete={props.isSignup ? 'email' : 'username'}
					placeholder="you@yourdomain.dev"
					data-field-ring
					{...fieldErrorProps('email', invalidFields, statusId)}
					css={authInputCss}
				/>
			</div>
			<div css={authFieldCss}>
				{props.isSignup ? (
					<label htmlFor={`${props.handleId}-password`} css={authFieldLabelCss}>
						Password
					</label>
				) : (
					<div css={authFieldLabelRowCss}>
						<label
							htmlFor={`${props.handleId}-password`}
							css={authFieldLabelCss}
						>
							Password
						</label>
						<SiteLink href="/reset-password" css={fieldAsideCss}>
							Forgot password?
						</SiteLink>
					</div>
				)}
				<PasswordRevealInput
					id={`${props.handleId}-password`}
					name="password"
					required
					minLength={props.isSignup ? minPasswordLength : undefined}
					autoComplete={props.isSignup ? 'new-password' : 'current-password'}
					placeholder={
						props.isSignup
							? `At least ${minPasswordLength} characters`
							: undefined
					}
					data-field-ring
					{...fieldErrorProps('password', invalidFields, statusId)}
					css={authInputCss}
				/>
			</div>
			{props.turnstileSiteKey ? (
				<div className={turnstileWidgetClassName}></div>
			) : null}
			{!props.isSignup ? (
				<label css={rememberCss}>
					<input
						type="checkbox"
						name="rememberMe"
						defaultChecked
						css={rememberInputCss}
					/>
					<span>Remember me on this device</span>
				</label>
			) : null}
			{renderStatusMessage(props.handleId, props.status, props.message)}
			<button
				type="submit"
				disabled={!props.isInteractive || props.isSubmitting}
				css={authSubmitCss}
			>
				<span
					data-swap-label
					data-active={props.isSubmitting ? undefined : true}
					aria-hidden={props.isSubmitting ? 'true' : undefined}
				>
					{props.submitLabel}
				</span>
				<span
					data-swap-label
					data-active={props.isSubmitting ? true : undefined}
					aria-hidden={props.isSubmitting ? undefined : 'true'}
				>
					{props.submitBusyLabel}
				</span>
			</button>
			{props.isSignup ? (
				<p css={signupConsentCss}>
					By creating an account you agree to the{' '}
					<SiteLink href="/terms">Terms of Service</SiteLink> and acknowledge
					the <SiteLink href="/privacy">Privacy Policy</SiteLink>.
				</p>
			) : null}
			{!props.isSignup ? (
				<button
					type="button"
					disabled={!props.isInteractive || props.isSubmitting}
					css={ghostButtonCss}
					onClick={props.onPasskeySignIn}
				>
					{renderIcon('key', { size: '17' })}
					Sign in with a passkey
				</button>
			) : null}
		</form>
	)
}

/* Brand panel: same flat canvas, shirt fabric across the whole panel, the
   layered lantern stage doing the welcoming. */
const authVisualCss: CSSObject = {
	position: 'relative' as const,
	display: 'flex',
	flexDirection: 'column' as const,
	justifyContent: 'space-between',
	gap: '2rem',
	padding: 'clamp(1.5rem, 3vw, 2.5rem)',
	borderRight: `1px solid ${colors.border}`,
	backgroundColor: colors.background,
	overflow: 'hidden',
	// See `pageHeadCss`: `isolate` keeps the fabric behind the panel content
	// without dropping it behind this panel's own background.
	isolation: 'isolate' as const,
	'&::before': {
		content: '""',
		position: 'absolute' as const,
		zIndex: -1,
		inset: 0,
		background: `radial-gradient(ellipse 70% 62% at 50% 52%, oklch(from ${colors.text} l c h / 0.06), transparent 78%)`,
		maskImage: 'var(--kody-pattern)',
		maskPosition: 'center',
		maskSize: '340px',
		maskRepeat: 'repeat',
		WebkitMaskImage: 'var(--kody-pattern)',
		WebkitMaskPosition: 'center',
		WebkitMaskSize: '340px',
		WebkitMaskRepeat: 'repeat',
		pointerEvents: 'none' as const,
	},
	[mobileMq]: {
		display: 'none',
	},
}

const brandBaseCss: CSSObject = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.6rem',
	font: `700 1.25rem/1 ${typography.fontFamilyDisplay}`,
	color: colors.text,
	textDecoration: 'none',
	letterSpacing: '-0.01em',
	'&:hover': { color: colors.text },
}

const authBrandCss: CSSObject = {
	...brandBaseCss,
	position: 'relative' as const,
	alignSelf: 'flex-start',
}

/* The brand only shows inside the form panel once the visual panel is gone. */
const authBrandMobileCss: CSSObject = {
	...brandBaseCss,
	display: 'none',
	[mobileMq]: {
		display: 'inline-flex',
		marginInline: 'auto',
	},
}

const authSceneCss: CSSObject = {
	position: 'relative' as const,
	textAlign: 'center' as const,
	marginInline: 'auto',
	width: '100%',
}

/* The lantern casts its light here too. */
const authStageWrapCss: CSSObject = {
	position: 'relative' as const,
	width: 'min(100%, 440px)',
	marginInline: 'auto',
	/* On short viewports the stage shrinks before anything clips. */
	'@media (min-width: 901px) and (max-height: 820px)': {
		width: 'min(100%, 340px)',
	},
	...getLanternGlowCss({ maxWidth: '160px' }),
}

const authGreetingCss: CSSObject = {
	margin: '1.6rem auto 0',
	font: `800 clamp(1.7rem, 2.4vw, 2.1rem)/1.1 ${typography.fontFamilyDisplay}`,
	letterSpacing: '-0.02em',
	color: colors.text,
}

const authGreetingSubCss: CSSObject = {
	margin: '0.7rem auto 0',
	color: colors.textMuted,
	maxWidth: '34ch',
}

const authFactCss: CSSObject = {
	position: 'relative' as const,
	margin: 0,
	textAlign: 'center' as const,
	fontSize: '0.92rem',
	color: colors.textMuted,
}

const authFormCss: CSSObject = {
	display: 'flex',
	flexDirection: 'column' as const,
	gap: '1.1rem',
}

/* Fields sit on the lighter surface, so they take the canvas tone and read
   as wells in both themes. */
const authInputCss = getAuthInputCss({ background: 'canvas' })

const inlineLinkCss: CSSObject = {
	color: colors.primaryText,
	textDecorationThickness: '1.5px',
	textUnderlineOffset: '3px',
	'&:hover': { color: colors.text },
}

const fieldAsideCss: CSSObject = {
	...inlineLinkCss,
	fontSize: '0.88rem',
}

const signupConsentCss: CSSObject = {
	margin: 0,
	fontSize: '0.85rem',
	lineHeight: 1.5,
	color: colors.textMuted,
	'& a': {
		color: colors.textMuted,
		textDecoration: 'underline',
		textDecorationThickness: '1.5px',
		textUnderlineOffset: '3px',
	},
	'& a:hover': { color: colors.text },
}

const rememberCss: CSSObject = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.6rem',
	fontSize: '0.95rem',
	color: colors.text,
	cursor: 'pointer',
	alignSelf: 'flex-start',
}

const rememberInputCss: CSSObject = {
	width: '1.1em',
	height: '1.1em',
	margin: 0,
	accentColor: colors.primary,
	cursor: 'pointer',
}

/* Status/error line. The `success-in` keyframes live in public/styles.css
   inside the reduced-motion-gated block, so the entrance simply no-ops when
   motion is off. */
export const formMessageCss: CSSObject = {
	margin: 0,
	fontSize: '0.95rem',
	lineHeight: 1.5,
	textAlign: 'left' as const,
	color: colors.textMuted,
	'& a': {
		color: colors.primaryText,
		textDecorationThickness: '1.5px',
		textUnderlineOffset: '3px',
	},
	'& a:hover': { color: colors.text },
	'&[data-tone="error"]': {
		color: colors.error,
	},
	[motionOk]: {
		'&:not([hidden])': {
			animation: `success-in 250ms ${transitions.easeOut} both`,
		},
	},
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

const ghostButtonCss = getGhostButtonCss()
