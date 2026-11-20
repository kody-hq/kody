/** @jsxImportSource @emotion/react */
import { Alert } from '../components/alert.tsx'
import { TextLink } from '../components/text-link.tsx'
import { Field } from '../components/field.tsx'
import { Button } from '../components/button.tsx'
import { buildAuthLink } from '#client/auth-links.ts'
// Top-level `import type` is erased; an inline `{ type X }` would keep a
// side-effect import that drags worker code into the client build.
import type { DevicePageData, DevicePageError } from '#start/server/device'
import {
	cardCss,
	descriptionCss,
	fieldLabelCss,
	insetCardCss,
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
import { AuthorizeOrgField } from './oauth-authorize-org-picker.tsx'
import { Input } from '../components/input.tsx'
import { Checkbox } from '../components/choice-controls.tsx'

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
		case 'confirm_required':
			return 'Tick the confirmation to approve: you are signing a browser in to your full Kody account.'
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
			<TextLink tone="muted" href="/">
				Back home
			</TextLink>
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
		case 'account_consent':
			return 'Sign a browser in to your account?'
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
		case 'account_consent':
			return 'A browser is asking to sign in to your whole Kody account, as you.'
		case 'done':
			if (data.result !== 'approved') {
				return 'Nothing was shared with that device. You can close this tab.'
			}
			switch (data.target) {
				case 'package_app':
					return 'The other device is finishing signing in to the app. It continues on its own within a few seconds; you can close this tab.'
				case 'account':
					return 'The other browser signs in to your Kody account within a few seconds. We emailed you a record of this sign-in. You can close this tab.'
				case 'cli':
					return 'Your device is finishing the sign-in. Return to your terminal; you can close this tab.'
			}
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
		case 'account_consent':
			return <AccountConsentCard data={data} />
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
				<Button
					href={buildAuthLink('/login', data.redirectTo)}
					variant="primary"
					size="md"
					reloadDocument
				>
					Sign in to continue
				</Button>
				<Button
					href={buildAuthLink('/signup', data.redirectTo)}
					variant="secondary"
					size="md"
					reloadDocument
				>
					Create an account
				</Button>
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
				<Alert role="alert" tone="error">
					{error}
				</Alert>
			) : null}
			<form
				method="get"
				action="/device"
				css={cardCss}
				data-testid="device-code-form"
			>
				<Field label="Device code">
					<Input
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
				</Field>
				<Button type="submit" variant="primary" size="md">
					Continue
				</Button>
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
			<Alert role="note" tone="error" data-testid="device-anti-phishing">
				{deviceAntiPhishingMessage}
			</Alert>
			<section css={insetCardCss}>
				<p css={signedInCss}>Signed in as {account.displayName}</p>
				<p css={descriptionCss}>{account.email}</p>
			</section>
			{orgUnavailableMessage ? (
				<Alert role="alert" tone="error">
					{orgUnavailableMessage}
				</Alert>
			) : null}
			{error ? (
				<Alert role="alert" tone="error">
					{error}
				</Alert>
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
						requiredOrgSlug={request.requestedOrgSlug}
						requiredReason={
							request.requestedOrgSlug
								? `This sign-in was started for @${request.requestedOrgSlug}. The organization cannot be changed here.`
								: null
						}
						onChange={setOrgSlug}
					/>
				)}
				<div css={actionsCss}>
					<Button
						type="submit"
						name="decision"
						value="approve"
						disabled={orgMissing}
						variant="primary"
						size="md"
					>
						Approve
					</Button>
					<Button
						type="submit"
						name="decision"
						value="deny"
						formNoValidate
						variant="secondary"
						size="md"
					>
						Deny
					</Button>
				</div>
			</form>
		</>
	)
}

function formatRequestedAt(epochSeconds: number) {
	return `${new Date(epochSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function formatMinutesAgo(minutes: number) {
	if (minutes < 1) return 'just now'
	return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`
}

function AccountConsentCard(props: {
	data: Extract<DevicePageData, { kind: 'account_consent' }>
}) {
	const { request, account } = props.data
	const error = deviceErrorText(props.data.error)
	return (
		<>
			<section css={cardCss} data-testid="account-device-grant">
				<h2 css={sectionTitleCss}>This gives a browser your full account</h2>
				<p css={descriptionCss}>
					Approving signs the browser below in to your Kody account as you, just
					like signing in there with your password. It can use your packages,
					memories, secrets, email, connected services, billing, and account
					settings until it signs out or you reset your password.
				</p>
				<div css={codeMatchCss}>
					<span css={fieldLabelCss}>Code on that browser</span>
					<code css={bigCodeCss} data-testid="device-user-code">
						{request.userCode}
					</code>
				</div>
				<dl css={factsCss} data-testid="account-device-request">
					<dt>Browser</dt>
					<dd data-testid="account-device-requester">{request.requester}</dd>
					<dt>Approximate location</dt>
					<dd data-testid="account-device-location">
						{request.location ?? 'Unknown'}
					</dd>
					<dt>Requested</dt>
					<dd data-testid="account-device-requested-at">
						{formatRequestedAt(request.requestedAt)} (
						{formatMinutesAgo(request.requestedMinutesAgo)})
					</dd>
				</dl>
				<p css={descriptionCss}>
					Location comes from the browser's network address and can be off by a
					city or more. The browser name is what that browser says it is.
				</p>
			</section>
			{request.differentCountry ? (
				<Alert
					role="alert"
					tone="error"
					data-testid="account-device-different-country"
				>
					That browser looks like it is in a different country from you. If you
					are not holding it right now, deny.
				</Alert>
			) : null}
			<Alert role="note" tone="error" data-testid="device-anti-phishing">
				Only approve a browser you are holding right now. Kody never asks you to
				approve a code someone sent you, read to you, or showed you on a
				website.
			</Alert>
			<section css={insetCardCss}>
				<p css={signedInCss}>Signed in as {account.displayName}</p>
				<p css={descriptionCss}>{account.email}</p>
			</section>
			{error ? (
				<Alert role="alert" tone="error">
					{error}
				</Alert>
			) : null}
			<form
				method="post"
				action="/device"
				css={cardCss}
				data-testid="account-device-consent-form"
			>
				<input type="hidden" name="user_code" value={request.userCode} />
				<label css={confirmCss}>
					<Checkbox
						name="confirm"
						value="full_account"
						required
						data-testid="account-device-confirm"
					/>
					<span>
						I understand: I am signing a browser in to my full Kody account.
					</span>
				</label>
				<div css={actionsCss}>
					<Button
						type="submit"
						name="decision"
						value="approve"
						variant="primary"
						size="md"
					>
						Sign that browser in
					</Button>
					<Button
						type="submit"
						name="decision"
						value="deny"
						formNoValidate
						variant="secondary"
						size="md"
					>
						Deny
					</Button>
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
const factsCss = {
	margin: 0,
	display: 'grid',
	gridTemplateColumns: 'auto 1fr',
	columnGap: spacing.md,
	rowGap: spacing.xs,
	color: colors.text,
	'& dt': { color: colors.textMuted },
	'& dd': { margin: 0, overflowWrap: 'anywhere' as const },
}
const confirmCss = {
	display: 'flex',
	alignItems: 'flex-start',
	gap: spacing.sm,
	color: colors.text,
	fontWeight: typography.fontWeight.medium,
}
