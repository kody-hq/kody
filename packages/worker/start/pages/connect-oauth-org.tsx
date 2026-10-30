/** @jsxImportSource @emotion/react */
import { isConnectOauthCallbackUrl } from '#universal/oauth-connect.ts'
import { orgIdentity, type OrganizationSummary } from '#universal/org-pages.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getPrimaryButtonCss,
	getSelectCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { UserAvatar } from '../components/user-avatar.tsx'

/** Personal org first, so it is the picker default. */
export function orderConnectOauthOrgs(
	organizations: ReadonlyArray<OrganizationSummary>,
) {
	return [
		...organizations.filter((org) => org.personal),
		...organizations.filter((org) => !org.personal),
	]
}

/**
 * Multi-org viewers must choose before any org-scoped app state is used.
 * Explicit `?org=` and the provider callback (org handed off in storage)
 * already name the target.
 */
export function shouldPickConnectOauthOrg(input: {
	organizations: ReadonlyArray<OrganizationSummary>
	flowOrg: string | null
	href: string
}) {
	if (input.organizations.length < 2 || input.flowOrg) return false
	return !isConnectOauthCallbackUrl(new URL(input.href, 'https://kody.local'))
}

export function connectOauthTargetOrg(input: {
	organizations: ReadonlyArray<OrganizationSummary>
	flowOrg: string | null
}) {
	return (
		input.organizations.find((org) => org.slug === input.flowOrg) ??
		input.organizations.find((org) => org.personal) ??
		input.organizations[0] ??
		null
	)
}

type ConnectOauthViewer = { displayName: string; avatarUrl: string | null }

function orgOptionLabel(org: OrganizationSummary, viewer: ConnectOauthViewer) {
	const identity = orgIdentity(org, viewer)
	return org.personal
		? `${identity.name} (personal)`
		: identity.hasName
			? `${identity.name} (${identity.handle})`
			: identity.name
}

/** Shows which organization the app and connection are saved to. */
export function ConnectOauthOrgTarget(props: {
	org: OrganizationSummary
	viewer: ConnectOauthViewer
}) {
	const identity = orgIdentity(props.org, props.viewer)
	return (
		<div css={targetCss} data-testid="connect-oauth-org-target">
			<UserAvatar
				displayName={identity.avatarName}
				avatarUrl={identity.avatarUrl}
				size={28}
				variant="well"
			/>
			<p css={targetTextCss}>
				<span css={mutedCss}>Saving to</span>{' '}
				<strong css={targetNameCss}>{identity.name}</strong>{' '}
				<span css={mutedCss}>
					{props.org.personal ? 'personal organization' : identity.handle}
				</span>
			</p>
		</div>
	)
}

/**
 * A plain GET form: submitting reloads the page with `?org=` so SSR resolves
 * that org's OAuth apps before the credentials form or connect step renders.
 */
export function ConnectOauthOrgPicker(props: {
	organizations: ReadonlyArray<OrganizationSummary>
	viewer: ConnectOauthViewer
	href: string
}) {
	const url = new URL(props.href, 'https://kody.local')
	const ordered = orderConnectOauthOrgs(props.organizations)
	const hidden = [...url.searchParams.entries()].filter(
		([key]) => key !== 'org',
	)
	return (
		<form
			method="get"
			action={url.pathname}
			css={cardCss}
			data-testid="connect-oauth-org-picker"
		>
			<h2 css={cardTitleCss}>Choose an organization</h2>
			<p css={descriptionCss}>
				The OAuth app and connection are saved to this organization. Members
				only see apps saved in their own organization.
			</p>
			{hidden.map(([key, value], index) => (
				<input key={`${key}-${index}`} type="hidden" name={key} value={value} />
			))}
			<label css={fieldCss}>
				<span css={fieldLabelCss}>Organization</span>
				<select
					name="org"
					css={getSelectCss()}
					defaultValue={ordered[0]?.slug}
					data-testid="connect-oauth-org-select"
				>
					{ordered.map((org) => (
						<option key={org.slug} value={org.slug}>
							{orgOptionLabel(org, props.viewer)}
						</option>
					))}
				</select>
			</label>
			<div>
				<button type="submit" css={getPrimaryButtonCss()}>
					Continue
				</button>
			</div>
		</form>
	)
}

const targetCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	minWidth: 0,
}

const targetTextCss = {
	margin: 0,
	minWidth: 0,
	fontSize: typography.fontSize.sm,
	color: colors.text,
	overflowWrap: 'anywhere' as const,
}

const mutedCss = { color: colors.textMuted }

const targetNameCss = { fontWeight: typography.fontWeight.semibold }
