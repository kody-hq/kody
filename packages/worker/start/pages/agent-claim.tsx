/** @jsxImportSource @emotion/react */
import { buildAuthLink } from '#client/auth-links.ts'
// Top-level `import type` is erased; an inline `{ type X }` would keep a
// side-effect import that drags worker code into the client build.
// oxlint-disable-next-line import/consistent-type-specifier-style
import type {
	AgentClaimPageData,
	AgentClaimPageError,
} from '#start/server/agent-claim'
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

const agentClaimAntiPhishingMessage =
	'Only continue if you asked an agent to connect Kody and the code matches the one it showed you.'

function agentClaimErrorText(error: AgentClaimPageError | null) {
	switch (error) {
		case null:
			return null
		case 'invalid_code':
			return 'That code does not match. Check the code your agent showed you and try again.'
		case 'rate_limited':
			return 'Too many attempts. Wait a few minutes before entering another code.'
		case 'email_unverified':
			return 'Verify your account email before connecting an agent.'
		case 'org_error':
			return 'Choose an organization this account can use for this agent.'
		default: {
			const exhaustive: never = error
			return exhaustive
		}
	}
}

export function AgentClaimRoute(props: { data: AgentClaimPageData }) {
	const { data } = props
	return (
		<section css={pageCss}>
			<header css={pageHeaderCss}>
				<span css={pageEyebrowCss}>Kody agent connection</span>
				<h1 css={pageTitleCss}>{agentClaimTitle(data)}</h1>
				<p css={pageDescriptionCss}>{agentClaimLead(data)}</p>
			</header>
			{renderAgentClaimBody(data)}
			<SiteLink href="/" css={mutedLinkCss}>
				Back home
			</SiteLink>
		</section>
	)
}

function agentClaimTitle(data: AgentClaimPageData) {
	switch (data.kind) {
		case 'signed_out':
		case 'consent':
			return 'Connect an agent'
		case 'not_found':
			return 'This link has expired'
		case 'email_mismatch':
			return 'Wrong account'
		case 'email_unverified':
			return 'Verify your email first'
		case 'done':
			return data.result === 'approved'
				? 'Agent connected'
				: 'Connection denied'
	}
}

function agentClaimLead(data: AgentClaimPageData) {
	switch (data.kind) {
		case 'signed_out':
			return 'Sign in to Kody or create an account, then enter the code your agent showed you.'
		case 'consent':
			return `An agent asked to connect to Kody for ${data.request.claimEmail}.`
		case 'not_found':
			return 'Ask your agent for a new link and code.'
		case 'email_mismatch':
			return `This agent asked to connect ${data.claimEmail}, but you are signed in as ${data.accountEmail}. Sign out and sign in as ${data.claimEmail}, or ask your agent to use your email.`
		case 'email_unverified':
			return `Open the verification link sent to ${data.accountEmail}, then come back to this page.`
		case 'done':
			return data.result === 'approved'
				? 'Your agent is finishing the connection. Return to it; you can close this tab.'
				: 'Nothing was shared with that agent. You can close this tab.'
	}
}

function renderAgentClaimBody(data: AgentClaimPageData) {
	switch (data.kind) {
		case 'signed_out':
			return <SignedOutCard data={data} />
		case 'consent':
			return <ConsentCard data={data} />
		case 'email_unverified':
			return (
				<section css={cardCss}>
					<a href="/pending-verification" css={primaryLinkCss}>
						Resend verification email
					</a>
				</section>
			)
		case 'not_found':
		case 'email_mismatch':
		case 'done':
			return null
	}
}

function SignedOutCard(props: {
	data: Extract<AgentClaimPageData, { kind: 'signed_out' }>
}) {
	const { data } = props
	return (
		<section css={cardCss} data-testid="agent-claim-signed-out">
			<p css={descriptionCss}>{agentClaimAntiPhishingMessage}</p>
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

function ConsentCard(props: {
	data: Extract<AgentClaimPageData, { kind: 'consent' }>
}) {
	const { request, account, attemptToken } = props.data
	const [orgSlug, setOrgSlug] = useState<string | null>(request.selectedOrgSlug)
	const error = agentClaimErrorText(props.data.error)
	const orgMissing = request.orgs.length === 0
	return (
		<>
			<section css={cardCss} data-testid="agent-claim-grant">
				<h2 css={sectionTitleCss}>
					{orgSlug
						? `The agent gets a Kody API token for @${orgSlug}`
						: 'The agent gets a Kody API token'}
				</h2>
				<p css={descriptionCss}>
					Approving gives that agent a token for the Kody API and CLI. It can
					run code and use your packages, memories, credentials, email, and jobs
					until the token expires or you revoke it from your account. It does
					not connect an MCP host.
				</p>
			</section>
			<p
				role="note"
				css={getAlertCardCss('error')}
				data-testid="agent-claim-anti-phishing"
			>
				{agentClaimAntiPhishingMessage}
			</p>
			<section css={insetCardCss}>
				<p css={signedInCss}>Signed in as {account.displayName}</p>
				<p css={descriptionCss}>{account.email}</p>
			</section>
			{error ? (
				<p role="alert" css={getAlertCardCss('error')}>
					{error}
				</p>
			) : null}
			<form
				method="post"
				action="/agent/claim"
				css={cardCss}
				data-testid="agent-claim-form"
			>
				<input type="hidden" name="claim_attempt_token" value={attemptToken} />
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Code from your agent</span>
					<input
						type="text"
						name="user_code"
						required
						autoFocus
						autoComplete="off"
						autoCapitalize="characters"
						spellCheck={false}
						maxLength={12}
						placeholder="BCDF-GHJK"
						css={codeInputCss}
					/>
				</label>
				<AuthorizeOrgField
					orgs={request.orgs}
					selectedOrgSlug={orgSlug}
					signedIn
					onChange={setOrgSlug}
				/>
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
const codeInputCss = {
	...inputCss,
	fontFamily: typography.fontFamilyMono,
	fontSize: typography.fontSize.lg,
	letterSpacing: '0.12em',
	textTransform: 'uppercase' as const,
}
const signedInCss = {
	margin: 0,
	fontWeight: typography.fontWeight.medium,
	color: colors.text,
}
