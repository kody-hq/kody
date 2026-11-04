/** @jsxImportSource @emotion/react */
import type { CSSObject } from '@emotion/react'
import { AuthLayout } from '../components/auth-layout.tsx'
import { renderIcon } from '../components/icon.tsx'
import { SiteLink } from '../components/site-link.tsx'
import type {
	GuestClaimPageData,
	GuestClaimPageError,
	GuestComesWithCounts,
} from '#start/server/guest-claim'
import {
	getPrimaryButtonCss,
	getSecondaryButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { formatGuestDate } from './guest-banner.tsx'

const errorCopy: Record<GuestClaimPageError, string> = {
	email_invalid: 'That does not look like an email address.',
	code_missing: 'Start again with your email to get a new code.',
	code_invalid: 'That code did not match. Check the email and try again.',
	code_expired: 'That code expired. Send a new one.',
	too_many_attempts: 'Too many wrong codes. Send a new one.',
	send_failed: 'Kody could not send the email. Try again in a minute.',
	already_claimed: 'This guest account was already claimed.',
	deleted: 'This guest account was deleted.',
	username_invalid:
		'Usernames use letters, numbers, and dashes. Try a different one.',
	username_taken: 'That username is taken. Try a different one.',
	email_taken:
		'That email already has a Kody account. Choose "I already have an account" instead.',
	no_account:
		'No Kody account uses that email yet. Make a new account instead.',
	merge_blocked:
		'Something in this guest account cannot move into that account. Make a new account instead.',
	no_verified_email:
		'That sign-in did not share a verified email. Try another way.',
	account_unavailable: 'That account cannot take a claim right now.',
	provider_unavailable: 'That sign-in option is not available right now.',
}

const pillLabels: Array<[keyof GuestComesWithCounts, string, string]> = [
	['packages', 'package', 'packages'],
	['memories', 'memory', 'memories'],
	['jobs', 'job', 'jobs'],
	['runs', 'run of history', 'runs of history'],
]

/** "Comes with you" pills. Empty categories get no pill; all empty hides it. */
function ComesWithYou(props: { counts: GuestComesWithCounts }) {
	const pills = pillLabels.flatMap(([key, one, many]) => {
		const value = props.counts[key] ?? 0
		return value > 0 ? [`${value} ${value === 1 ? one : many}`] : []
	})
	if (pills.length === 0) return null
	return (
		<section aria-label="Comes with you" css={comesWithCss}>
			<h2 css={sectionLabelCss}>Comes with you</h2>
			<ul css={pillListCss}>
				{pills.map((label) => (
					<li key={label} css={pillCss}>
						{label}
					</li>
				))}
			</ul>
		</section>
	)
}

export function GuestClaimRoute(props: { data: GuestClaimPageData }) {
	const { data } = props
	if (data.kind === 'not_found') {
		return (
			<AuthLayout
				title="This claim link is not active"
				description="The guest account was already claimed or has been deleted."
			>
				<SiteLink href="/login" css={primaryLinkCss}>
					Log in
				</SiteLink>
			</AuthLayout>
		)
	}
	if (data.kind === 'claimed') return <GuestClaimed data={data} />
	return <GuestClaimForms data={data} />
}

function GuestClaimed(props: {
	data: Extract<GuestClaimPageData, { kind: 'claimed' }>
}) {
	const { data } = props
	return (
		<AuthLayout
			title="Your account is claimed"
			description={
				data.mode === 'merge'
					? 'Everything from the guest account moved into your account.'
					: data.username
						? `Welcome to Kody, ${data.username}. Your guest work is now yours to keep.`
						: 'Your guest work is now yours to keep.'
			}
		>
			<div css={stackCss}>
				<span css={checkBadgeCss} aria-hidden="true">
					{renderIcon('check', { size: '1.4rem' })}
				</span>
				<ComesWithYou counts={data.comesWith} />
				<ul css={checkListCss}>
					<li css={checkItemCss}>
						{renderIcon('check', { size: '1rem' })}
						<span>
							Your connected agents keep working. No need to reconnect or log in
							again.
						</span>
					</li>
					{data.mode === 'merge' ? null : (
						<li css={checkItemCss}>
							{renderIcon('check', { size: '1rem' })}
							<span>Your $5 welcome credits are on the account.</span>
						</li>
					)}
				</ul>
				<SiteLink href="/account" css={primaryLinkCss}>
					Go to your account
				</SiteLink>
			</div>
		</AuthLayout>
	)
}

function GuestClaimForms(props: {
	data: Extract<GuestClaimPageData, { kind: 'claim' }>
}) {
	const { data } = props
	const action = `/claim/${encodeURIComponent(data.code)}`
	const status =
		data.phase === 'active'
			? `Full access until ${formatGuestDate(data.fullAccessUntil)} MT. Claim it to keep everything.`
			: `Full access ended, so this account is read-only. It will be deleted on ${formatGuestDate(data.deleteAt)} MT unless you claim it.`
	return (
		<AuthLayout title="Claim your guest account" description={status}>
			<div css={stackCss}>
				{data.phase === 'hold' ? (
					<p role="status" css={holdNoticeCss}>
						Read-only hold. Delete date: {formatGuestDate(data.deleteAt)} MT
					</p>
				) : null}
				{data.error ? (
					<p role="alert" css={errorCss}>
						{errorCopy[data.error]}
					</p>
				) : null}
				<ComesWithYou counts={data.comesWith} />
				{data.step === 'code' ? (
					<form method="post" action={action} css={formCss}>
						<input type="hidden" name="action" value="email_finish" />
						<input type="hidden" name="email" value={data.codeEmail ?? ''} />
						<label css={labelCss}>
							<span>
								Enter the code sent to {data.codeEmail || 'your email'}
							</span>
							<input
								name="code"
								inputMode="numeric"
								autoComplete="one-time-code"
								pattern="[0-9]*"
								maxLength={6}
								required
								css={inputCss}
								defaultValue={data.devCode ?? ''}
							/>
						</label>
						<button type="submit" css={primaryButtonCss}>
							Finish claiming
						</button>
						<SiteLink href={action} css={mutedLinkCss}>
							Use a different email
						</SiteLink>
					</form>
				) : (
					<>
						{data.signedInAccount ? (
							<form method="post" action={action} css={cardCss}>
								<input type="hidden" name="action" value="merge_signed_in" />
								<h2 css={sectionTitleCss}>
									Move it into {data.signedInAccount.username}
								</h2>
								<p css={mutedCss}>
									Packages, memories, jobs, and run history move into your
									account. Name clashes get a new name.
								</p>
								<button type="submit" css={primaryButtonCss}>
									Move everything into this account
								</button>
							</form>
						) : null}
						<section css={cardCss} aria-labelledby="claim-new">
							<h2 id="claim-new" css={sectionTitleCss}>
								Make a new account
							</h2>
							<form method="post" action={action} css={formCss}>
								<input type="hidden" name="action" value="email_start" />
								<input type="hidden" name="mode" value="new" />
								<label css={labelCss}>
									<span>Username</span>
									<input
										name="username"
										autoComplete="username"
										required
										css={inputCss}
									/>
								</label>
								<label css={labelCss}>
									<span>Email</span>
									<input
										name="email"
										type="email"
										autoComplete="email"
										required
										css={inputCss}
									/>
								</label>
								<button type="submit" css={primaryButtonCss}>
									Email me a code
								</button>
							</form>
							<ProviderButtons action={action} providers={data.providers} />
						</section>
						<section css={cardCss} aria-labelledby="claim-existing">
							<h2 id="claim-existing" css={sectionTitleCss}>
								I already have an account
							</h2>
							<form method="post" action={action} css={formCss}>
								<input type="hidden" name="action" value="email_start" />
								<input type="hidden" name="mode" value="merge" />
								<label css={labelCss}>
									<span>Account email</span>
									<input
										name="email"
										type="email"
										autoComplete="email"
										required
										css={inputCss}
									/>
								</label>
								<button type="submit" css={secondaryButtonCss}>
									Email me a code
								</button>
							</form>
							<ProviderButtons action={action} providers={data.providers} />
						</section>
						<p css={mutedCss}>
							Claiming keeps your connected agents working. No need to reconnect
							or log in again.
						</p>
					</>
				)}
			</div>
		</AuthLayout>
	)
}

function ProviderButtons(props: {
	action: string
	providers: { github: boolean; google: boolean }
}) {
	const options = [
		props.providers.github ? (['github', 'GitHub'] as const) : null,
		props.providers.google ? (['google', 'Google'] as const) : null,
	].filter((value) => value !== null)
	if (options.length === 0) return null
	return (
		<div css={providerRowCss}>
			{options.map(([provider, label]) => (
				<form key={provider} method="post" action={props.action}>
					<input type="hidden" name="action" value="provider" />
					<input type="hidden" name="provider" value={provider} />
					<button type="submit" css={providerButtonCss}>
						Continue with {label}
					</button>
				</form>
			))}
		</div>
	)
}

const primaryButtonCss = {
	...getPrimaryButtonCss({ size: 'lg', weight: 'semibold' }),
	width: '100%',
}
const secondaryButtonCss = {
	...getSecondaryButtonCss({ size: 'lg', weight: 'semibold' }),
	width: '100%',
}
const providerButtonCss = { ...getSecondaryButtonCss(), width: '100%' }
const primaryLinkCss: CSSObject = {
	...primaryButtonCss,
	display: 'inline-flex',
	justifyContent: 'center',
	textDecoration: 'none',
}
const stackCss: CSSObject = { display: 'grid', gap: spacing.lg }
const formCss: CSSObject = { display: 'grid', gap: spacing.sm }
const cardCss: CSSObject = {
	display: 'grid',
	gap: spacing.md,
	padding: spacing.lg,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.lg,
	background: colors.background,
}
const sectionTitleCss: CSSObject = {
	margin: 0,
	fontSize: typography.fontSize.base,
	fontWeight: typography.fontWeight.semibold,
}
const sectionLabelCss: CSSObject = {
	margin: 0,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.semibold,
	color: colors.textMuted,
}
const labelCss: CSSObject = {
	display: 'grid',
	gap: spacing.xs,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.medium,
}
const inputCss: CSSObject = {
	font: 'inherit',
	fontSize: typography.fontSize.base,
	padding: '0.6rem 0.75rem',
	border: `1px solid ${colors.fieldBorder}`,
	borderRadius: radius.md,
	background: colors.surface,
	color: colors.text,
	minHeight: '44px',
}
const mutedCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.5,
}
const mutedLinkCss: CSSObject = {
	...mutedCss,
	justifySelf: 'center',
}
const errorCss: CSSObject = {
	margin: 0,
	padding: spacing.md,
	borderRadius: radius.md,
	border: `1px solid ${colors.danger}`,
	color: colors.danger,
	fontSize: typography.fontSize.sm,
}
const holdNoticeCss: CSSObject = {
	margin: 0,
	padding: spacing.md,
	borderRadius: radius.md,
	border: `1px solid ${colors.warning}`,
	color: colors.warningText,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.semibold,
}
const comesWithCss: CSSObject = { display: 'grid', gap: spacing.sm }
const pillListCss: CSSObject = {
	display: 'flex',
	flexWrap: 'wrap',
	gap: spacing.sm,
	margin: 0,
	padding: 0,
	listStyle: 'none',
}
const pillCss: CSSObject = {
	padding: '0.3rem 0.75rem',
	borderRadius: radius.full,
	background: colors.primarySoftest,
	color: colors.primaryText,
	border: `1px solid ${colors.primarySoft}`,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.medium,
}
const providerRowCss: CSSObject = {
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))',
	gap: spacing.sm,
}
const checkBadgeCss: CSSObject = {
	justifySelf: 'center',
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '2.75rem',
	height: '2.75rem',
	borderRadius: radius.full,
	background: colors.primarySoft,
	color: colors.primaryText,
}
const checkListCss: CSSObject = {
	display: 'grid',
	gap: spacing.sm,
	margin: 0,
	padding: 0,
	listStyle: 'none',
}
const checkItemCss: CSSObject = {
	display: 'flex',
	gap: spacing.sm,
	alignItems: 'flex-start',
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	'& svg': { color: colors.primary, flex: 'none', marginTop: '0.15rem' },
}
