/** @jsxImportSource @emotion/react */
// Top-level `import type` is erased; an inline `{ type X }` would keep a
// side-effect import that drags worker code into the client build.
// oxlint-disable-next-line import/consistent-type-specifier-style
import type { AccountDeviceSignInView } from '#start/server/account-device'
import { accountDeviceSignInPath } from '#universal/oauth-paths.ts'
import {
	cardCss,
	descriptionCss,
	fieldLabelCss,
	getAlertCardCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	insetCardCss,
	pageDescriptionCss,
	pageEyebrowCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

/**
 * The asking browser's half of full-account "Sign in on another device" (ADR
 * 0094). Plain server-rendered HTML: an HTTP `Refresh` header keeps checking
 * while it waits, so it works with JavaScript turned off.
 */
export function AccountDeviceSignInPage(props: {
	data: AccountDeviceSignInView
}) {
	const { data } = props
	return (
		<section css={pageCss} data-testid="account-device-sign-in">
			<header css={pageHeaderCss}>
				<span css={pageEyebrowCss}>Sign in to Kody</span>
				<h1 css={pageTitleCss}>{titleFor(data)}</h1>
				<p css={pageDescriptionCss}>{leadFor(data)}</p>
			</header>
			{renderBody(data)}
		</section>
	)
}

function titleFor(data: AccountDeviceSignInView) {
	switch (data.kind) {
		case 'pending':
			return 'Sign in on another device'
		case 'denied':
			return 'Sign-in was denied'
		case 'expired':
			return 'This code expired'
		case 'none':
			return 'No sign-in in progress'
	}
}

function leadFor(data: AccountDeviceSignInView) {
	switch (data.kind) {
		case 'pending':
			return 'Use a phone or computer where you are already signed in to Kody to sign this browser in to your account.'
		case 'denied':
			return 'The sign-in was denied on the other device. This browser is not signed in.'
		case 'expired':
			return 'Codes last five minutes. Start again to get a new one.'
		case 'none':
			return data.error === 'rate_limited'
				? 'Too many sign-in requests from this network. Wait a few minutes, then start again.'
				: 'Start from the Kody sign-in page, then choose "Sign in on another device".'
	}
}

function renderBody(data: AccountDeviceSignInView) {
	switch (data.kind) {
		case 'pending':
			return <PendingCard data={data} />
		case 'denied':
		case 'expired':
			return (
				<div css={actionsCss}>
					<a
						href={data.startAgainUrl}
						css={primaryLinkCss}
						data-testid="account-device-start-again"
					>
						Start again
					</a>
				</div>
			)
		case 'none':
			return (
				<div css={actionsCss}>
					<a href="/login" css={primaryLinkCss}>
						Go to sign in
					</a>
				</div>
			)
	}
}

function PendingCard(props: {
	data: Extract<AccountDeviceSignInView, { kind: 'pending' }>
}) {
	const { data } = props
	return (
		<>
			<section css={cardCss}>
				<ol css={stepsCss}>
					<li>
						On your other device, open{' '}
						<strong css={urlCss}>{displayUrl(data.verificationUri)}</strong> or
						scan the QR code.
					</li>
					<li>Sign in to Kody there if you are not already.</li>
					<li>
						Check that the code matches, confirm, then approve signing this
						browser in to your account.
					</li>
				</ol>
				<div css={codeRowCss}>
					<div css={codeBlockCss}>
						<span css={fieldLabelCss}>Your code</span>
						<code css={bigCodeCss} data-testid="account-device-user-code">
							{data.userCode}
						</code>
						<span css={descriptionCss}>
							Expires in about {data.minutesLeft}{' '}
							{data.minutesLeft === 1 ? 'minute' : 'minutes'}.
						</span>
					</div>
					<svg
						role="img"
						aria-label={`QR code for ${displayUrl(data.verificationUriComplete)}`}
						viewBox={`0 0 ${data.qr.size} ${data.qr.size}`}
						width="168"
						height="168"
						shapeRendering="crispEdges"
						css={qrCss}
						data-testid="account-device-qr"
					>
						<rect width={data.qr.size} height={data.qr.size} fill="#ffffff" />
						<path d={data.qr.path} fill="#111111" />
					</svg>
				</div>
			</section>
			<section css={insetCardCss}>
				<p css={descriptionCss}>
					This page checks for your approval every {data.refreshSeconds} seconds
					and signs you in on its own.
				</p>
				<div css={actionsCss}>
					<a
						href={accountDeviceSignInPath}
						css={secondaryLinkCss}
						data-testid="account-device-check-now"
					>
						Check now
					</a>
				</div>
			</section>
			<p role="note" css={getAlertCardCss('info')}>
				Never read this code to anyone or approve a code someone sent you.
				Approving gives this browser your whole Kody account.
			</p>
		</>
	)
}

/** `https://kody.codes/device` reads better as `kody.codes/device`. */
function displayUrl(href: string) {
	try {
		const url = new URL(href)
		return `${url.host}${url.pathname}${url.search}`
	} catch {
		return href
	}
}

const pageCss = {
	...stackedPageCss,
	maxWidth: '32rem',
	margin: '0 auto',
}
const primaryButtonCss = getPrimaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})
const secondaryButtonCss = getSecondaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})
const primaryLinkCss = {
	...primaryButtonCss,
	textDecoration: 'none',
	'&:hover': { textDecoration: 'none' },
}
const secondaryLinkCss = {
	...secondaryButtonCss,
	textDecoration: 'none',
	'&:hover': { textDecoration: 'none' },
}
const actionsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
}
const stepsCss = {
	margin: 0,
	paddingLeft: '1.25rem',
	display: 'grid',
	gap: spacing.xs,
	color: colors.text,
}
const urlCss = {
	fontFamily: typography.fontFamilyMono,
	overflowWrap: 'anywhere' as const,
}
const codeRowCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: spacing.lg,
}
const codeBlockCss = {
	display: 'grid',
	gap: spacing.xs,
}
const bigCodeCss = {
	fontFamily: typography.fontFamilyMono,
	fontSize: typography.fontSize.xl,
	fontWeight: typography.fontWeight.semibold,
	letterSpacing: '0.12em',
	color: colors.text,
}
const qrCss = {
	display: 'block',
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: '#ffffff',
}
