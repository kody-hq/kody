/** @jsxImportSource @emotion/react */
// Top-level `import type` is erased; an inline `{ type X }` would keep a
// side-effect import that drags worker code into the client build.
// oxlint-disable-next-line import/consistent-type-specifier-style
import type { PackageAppDeviceSignInView } from '#start/server/package-app-device'
import { packageAppOauthPaths } from '#universal/package-app-oauth-paths.ts'
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
 * The limited browser's half of "Sign in on another device" (ADR 0094). Every
 * state is plain server-rendered HTML: the page refreshes itself with an HTTP
 * `Refresh` header while it waits, and "Check now" is an ordinary link, so it
 * works with JavaScript turned off.
 */
export function PackageAppDeviceSignInPage(props: {
	data: PackageAppDeviceSignInView
}) {
	const { data } = props
	return (
		<section css={pageCss} data-testid="package-app-device-sign-in">
			<header css={pageHeaderCss}>
				<span css={pageEyebrowCss}>Sign in with Kody</span>
				<h1 css={pageTitleCss}>{titleFor(data)}</h1>
				<p css={pageDescriptionCss}>{leadFor(data)}</p>
			</header>
			{renderBody(data)}
		</section>
	)
}

function titleFor(data: PackageAppDeviceSignInView) {
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

function leadFor(data: PackageAppDeviceSignInView) {
	switch (data.kind) {
		case 'pending':
			return `Use a phone or computer where you are signed in to Kody to approve ${data.appName} on this browser.`
		case 'denied':
			return `The request to sign in to ${data.appName} was denied on the other device. Nothing was shared with this browser.`
		case 'expired':
			return `Codes last a few minutes. Start again from ${data.appName} to get a new one.`
		case 'none':
			return data.error === 'rate_limited'
				? 'Too many sign-in requests from this network. Wait a minute, then start again from the app.'
				: 'Start from the app you were signing in to, then choose "Sign in on another device".'
	}
}

function renderBody(data: PackageAppDeviceSignInView) {
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
						data-testid="package-app-device-start-again"
					>
						Start again
					</a>
				</div>
			)
		case 'none':
			return null
	}
}

function PendingCard(props: {
	data: Extract<PackageAppDeviceSignInView, { kind: 'pending' }>
}) {
	const { data } = props
	const minutes = Math.max(
		1,
		Math.round((data.expiresAt * 1000 - Date.now()) / 60_000),
	)
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
						Check that the code matches, then allow{' '}
						<strong>{data.appName}</strong>.
					</li>
				</ol>
				<div css={codeRowCss}>
					<div css={codeBlockCss}>
						<span css={fieldLabelCss}>Your code</span>
						<code css={bigCodeCss} data-testid="package-app-device-user-code">
							{data.userCode}
						</code>
						<span css={descriptionCss}>
							Expires in about {minutes} {minutes === 1 ? 'minute' : 'minutes'}.
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
						data-testid="package-app-device-qr"
					>
						<rect width={data.qr.size} height={data.qr.size} fill="#ffffff" />
						<path d={data.qr.path} fill="#111111" />
					</svg>
				</div>
			</section>
			<section css={insetCardCss}>
				<p css={descriptionCss}>
					This page checks for your approval every {data.refreshSeconds} seconds
					and continues to the app on its own.
				</p>
				<div css={actionsCss}>
					<a
						href={packageAppOauthPaths.device}
						css={secondaryLinkCss}
						data-testid="package-app-device-check-now"
					>
						Check now
					</a>
				</div>
			</section>
			<p role="note" css={getAlertCardCss('info')}>
				Only approve on a device you trust, and only if you started this sign-in
				here yourself.
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
const primaryButtonCss = getPrimaryButtonCss({ size: 'lg', weight: 'semibold' })
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
