/** @jsxImportSource @emotion/react */
import { buildAuthLink } from '#client/auth-links.ts'
// Top-level `import type` is erased; an inline `{ type X }` would keep a
// side-effect import that drags worker code into the client build.
// oxlint-disable-next-line import/consistent-type-specifier-style
import type { DevicePageData, DevicePageError } from '#start/server/device'
import {
	cardCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getAlertCardCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	insetCardCss,
	inputCss,
	mutedLinkCss,
	nativeDisclosureCss,
	pageDescriptionCss,
	pageEyebrowCss,
	pageHeaderCss,
	pageTitleCss,
	sectionTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { useState } from 'react'
import { SiteLink } from '../components/site-link.tsx'
import { AuthorizeOrgField } from './oauth-authorize-org-picker.tsx'

const deviceAntiPhishingMessage =
	'Only continue if you started this sign-in yourself on a device you control.'

function deviceErrorText(error: DevicePageError | null) {
	switch (error) {
		case null:
			return null
		case 'invalid_code':
			return 'Codes are 8 letters, like BCDF-GHJK. Check the code on your device and try again.'
		case 'not_found':
			return 'That code is not valid or has expired. Check your device, or start the sign-in again there.'
		case 'rate_limited':
			return 'Too many attempts. Wait a few minutes before entering another code.'
		case 'email_unverified':
			return 'Verify your account email before approving a device. Open the link from your inbox, then come back to this page.'
		case 'org_error':
			return 'Choose an organization this account can use for this sign-in.'
		default: {
			const exhaustive: never = error
			return exhaustive
		}
	}
}

export function DeviceRoute(props: { data: DevicePageData }) {
	const { data } = props
	return (
		<section css={pageCss}>
			<header css={pageHeaderCss}>
				<span css={pageEyebrowCss}>Kody device sign-in</span>
				<h1 css={pageTitleCss}>{deviceTitle(data)}</h1>
				<p css={pageDescriptionCss}>{deviceLead(data)}</p>
			</header>
			{renderDeviceBody(data)}
			<SiteLink href="/" css={mutedLinkCss}>
				Back home
			</SiteLink>
		</section>
	)
}

function deviceTitle(data: DevicePageData) {
	switch (data.kind) {
		case 'signed_out':
		case 'enter':
			return 'Sign in on a device'
		case 'consent':
			return 'Approve this device?'
		case 'done':
			return data.result === 'approved' ? 'Device approved' : 'Sign-in denied'
	}
}

function deviceLead(data: DevicePageData) {
	switch (data.kind) {
		case 'signed_out':
			return 'Sign in to Kody, then confirm the code shown on your device.'
		case 'enter':
			return 'Enter the code shown in your terminal or on your device.'
		case 'consent':
			return `${data.request.clientName} is asking to sign in to your Kody account.`
		case 'done':
			return data.result === 'approved'
				? 'Your device is finishing the sign-in. Return to your terminal; you can close this tab.'
				: 'Nothing was shared with that device. You can close this tab.'
	}
}

function renderDeviceBody(data: DevicePageData) {
	switch (data.kind) {
		case 'signed_out':
			return <SignedOutCard data={data} />
		case 'enter':
			return <CodeEntryCard data={data} />
		case 'consent':
			return <ConsentCard data={data} />
		case 'done':
			return null
	}
}

function SignedOutCard(props: {
	data: Extract<DevicePageData, { kind: 'signed_out' }>
}) {
	const { data } = props
	return (
		<section css={cardCss} data-testid="device-signed-out">
			{data.userCode ? (
				<p css={descriptionCss}>
					Code from your device:{' '}
					<code css={inlineCodeCss}>{data.userCode}</code>
				</p>
			) : null}
			<p css={descriptionCss}>{deviceAntiPhishingMessage}</p>
			<div css={actionsCss}>
				<a href={buildAuthLink('/login', data.redirectTo)} css={primaryLinkCss}>
					Sign in to continue
				</a>
				<a
					href={buildAuthLink('/signup', data.redirectTo)}
					css={secondaryLinkCss}
				>
					Create an account
				</a>
			</div>
		</section>
	)
}

function CodeEntryCard(props: {
	data: Extract<DevicePageData, { kind: 'enter' }>
}) {
	const { data } = props
	const error = deviceErrorText(data.error)
	return (
		<>
			{error ? (
				<p role="alert" css={getAlertCardCss('error')}>
					{error}
				</p>
			) : null}
			<form
				method="get"
				action="/device"
				css={cardCss}
				data-testid="device-code-form"
			>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Device code</span>
					<input
						type="text"
						name="user_code"
						required
						autoFocus
						defaultValue={data.userCode ?? ''}
						autoComplete="off"
						autoCapitalize="characters"
						spellCheck={false}
						maxLength={12}
						placeholder="BCDF-GHJK"
						css={codeInputCss}
					/>
				</label>
				<button type="submit" css={primaryButtonCss}>
					Continue
				</button>
			</form>
		</>
	)
}

function ConsentCard(props: {
	data: Extract<DevicePageData, { kind: 'consent' }>
}) {
	const { request, account } = props.data
	const [orgSlug, setOrgSlug] = useState<string | null>(request.selectedOrgSlug)
	const error = deviceErrorText(props.data.error)
	const orgMissing = request.orgs.length === 0
	const orgUnavailableMessage = request.requestedOrgUnavailable
		? `This sign-in was started for @${request.requestedOrgSlug}, which this account cannot use. Deny it, or sign in with an account in that organization.`
		: null
	return (
		<>
			<section css={cardCss} data-testid="device-grant">
				<h2 css={sectionTitleCss}>
					{orgSlug
						? `${request.clientName} gets full access in @${orgSlug}`
						: `${request.clientName} gets full access`}
				</h2>
				<p css={descriptionCss}>
					Approving signs the Kody CLI on that device in to your Kody
					{orgSlug ? ` organization @${orgSlug}` : ' account'}. It can use your
					packages, memories, secrets, email, connected services, and anything
					else your account can do, until you log out there or revoke it from
					your account.
				</p>
				<div css={codeMatchCss}>
					<span css={fieldLabelCss}>Code on your device</span>
					<code css={bigCodeCss} data-testid="device-user-code">
						{request.userCode}
					</code>
				</div>
				{request.scopes.length > 0 ? (
					<details css={nativeDisclosureCss} data-testid="device-scopes">
						<summary>Requested scopes</summary>
						<div>
							<p css={descriptionCss}>
								These OAuth scopes are identity claims. They do not limit what
								the CLI can do.
							</p>
							<p css={scopeListCss}>
								{request.scopes.map((scope) => (
									<code key={scope}>{scope}</code>
								))}
							</p>
						</div>
					</details>
				) : null}
			</section>
			<p
				role="note"
				css={getAlertCardCss('error')}
				data-testid="device-anti-phishing"
			>
				{deviceAntiPhishingMessage}
			</p>
			<section css={insetCardCss}>
				<p css={signedInCss}>Signed in as {account.displayName}</p>
				<p css={descriptionCss}>{account.email}</p>
			</section>
			{orgUnavailableMessage ? (
				<p role="alert" css={getAlertCardCss('error')}>
					{orgUnavailableMessage}
				</p>
			) : null}
			{error ? (
				<p role="alert" css={getAlertCardCss('error')}>
					{error}
				</p>
			) : null}
			<form
				method="post"
				action="/device"
				css={cardCss}
				data-testid="device-consent-form"
			>
				<input type="hidden" name="user_code" value={request.userCode} />
				{request.requestedOrgUnavailable ? null : (
					<AuthorizeOrgField
						orgs={request.orgs}
						selectedOrgSlug={orgSlug}
						signedIn
						onChange={setOrgSlug}
					/>
				)}
				<div css={actionsCss}>
					<button
						type="submit"
						name="decision"
						value="approve"
						disabled={orgMissing}
						css={primaryButtonCss}
					>
						Approve
					</button>
					<button
						type="submit"
						name="decision"
						value="deny"
						formNoValidate
						css={secondaryButtonCss}
					>
						Deny
					</button>
				</div>
			</form>
		</>
	)
}

const pageCss = {
	...stackedPageCss,
	maxWidth: '28rem',
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
const inlineCodeCss = {
	fontFamily: typography.fontFamilyMono,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
}
const codeInputCss = {
	...inputCss,
	fontFamily: typography.fontFamilyMono,
	fontSize: typography.fontSize.lg,
	letterSpacing: '0.12em',
	textTransform: 'uppercase' as const,
}
const codeMatchCss = {
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
const scopeListCss = {
	...descriptionCss,
	display: 'flex',
	flexWrap: 'wrap' as const,
	columnGap: spacing.md,
	rowGap: spacing.xs,
	alignItems: 'baseline',
}
const signedInCss = {
	margin: 0,
	fontWeight: typography.fontWeight.medium,
	color: colors.text,
}
