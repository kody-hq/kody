/** @jsxImportSource @emotion/react */
import { useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { decidePackageAppOauthConsent } from '#start/server/package-app-oauth'
import {
	AccountManagementHeader,
	AccountManagementShell,
	IdValue,
	MetadataGrid,
	accountActionsCss,
	accountDisclosureCss,
} from './account-management-components.tsx'
import { type PackageAppOauthConsentLoaderData } from '#universal/loader-data.ts'
import { packageAppOauthPaths } from '#universal/package-app-oauth-paths.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

export function PackageAppOauthConsentPage({
	data,
}: {
	data: PackageAppOauthConsentLoaderData
}) {
	const send = useServerFn(decidePackageAppOauthConsent)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	async function submit(decision: 'approve' | 'deny') {
		if (busy) return
		setBusy(true)
		setError(null)
		try {
			await send({ data: { fields: data.hiddenFields, decision } })
		} catch (failure) {
			setError(
				failure instanceof Error
					? failure.message
					: 'Unable to authorize this app.',
			)
		} finally {
			setBusy(false)
		}
	}
	const detailItems = [
		{
			label: 'Client ID',
			value: <IdValue value={data.clientId} label="client id" />,
		},
		{
			label: 'Package id',
			value: <IdValue value={data.kodyId} label="package id" />,
		},
		{
			label: 'Publisher handle',
			value: <IdValue value={data.publisherUsername} label="publisher" />,
		},
		{
			label: 'Redirect URI',
			value: <IdValue value={data.redirectUri} label="redirect uri" />,
		},
		{
			label: 'Scopes',
			value: <IdValue value={data.scopes.join(' ')} label="scopes" />,
		},
	]

	return (
		<AccountManagementShell maxWidth="40rem">
			<AccountManagementHeader
				title={`Allow ${data.packageName}?`}
				description={`${data.packageName} wants to use your Kody account. Review what it can see, then allow or cancel.`}
			/>
			<section
				data-testid="package-app-oauth-consent"
				css={{ display: 'grid', gap: spacing.lg }}
			>
				<div css={identityRowCss}>
					{data.iconUrl ? (
						<img
							src={data.iconUrl}
							alt=""
							width={48}
							height={48}
							css={iconCss}
						/>
					) : (
						<span aria-hidden="true" css={iconFallbackCss}>
							{data.packageName.slice(0, 1).toUpperCase()}
						</span>
					)}
					<div css={{ display: 'grid', gap: spacing.xs, minWidth: 0 }}>
						<strong
							css={{
								margin: 0,
								fontSize: typography.fontSize.lg,
								fontWeight: typography.fontWeight.semibold,
								color: colors.text,
								overflowWrap: 'anywhere',
							}}
						>
							{data.packageName}
						</strong>
						<p css={mutedCss}>
							Published by {data.publisherDisplayName} (@
							{data.publisherUsername})
						</p>
						{data.appDomain ? (
							<p css={mutedCss}>
								App domain <code css={codeCss}>{data.appDomain}</code>
							</p>
						) : null}
						<p css={mutedCss}>Signed in as {data.viewerDisplayName}</p>
					</div>
				</div>

				<section css={{ display: 'grid', gap: spacing.sm }}>
					<h2 css={sectionHeadingCss}>This app will be able to</h2>
					<ul css={claimListCss}>
						{data.claimLabels.map((claim) => (
							<li key={claim}>{claim}</li>
						))}
					</ul>
				</section>

				<details
					data-testid="package-app-oauth-consent-details"
					css={accountDisclosureCss}
				>
					<summary>Details</summary>
					<MetadataGrid items={detailItems} />
				</details>

				<form
					method="post"
					action={packageAppOauthPaths.authorize}
					onSubmit={(event) => {
						event.preventDefault()
						const decision = (
							event.nativeEvent as SubmitEvent
						).submitter?.getAttribute('value')
						if (decision === 'approve' || decision === 'deny')
							void submit(decision)
					}}
					css={accountActionsCss}
				>
					{Object.entries(data.hiddenFields).map(([name, value]) => (
						<input key={name} type="hidden" name={name} value={value} />
					))}
					<button
						disabled={busy}
						type="submit"
						name="decision"
						value="approve"
						data-testid="package-app-oauth-approve"
						css={getPillButtonCss({ size: 'sm' })}
					>
						Allow
					</button>
					<button
						disabled={busy}
						type="submit"
						name="decision"
						value="deny"
						data-testid="package-app-oauth-deny"
						css={getGhostButtonCss({ size: 'sm' })}
					>
						Cancel
					</button>
				</form>
				{error ? (
					<p role="alert" css={mutedCss}>
						{error}
					</p>
				) : null}
			</section>
		</AccountManagementShell>
	)
}

const identityRowCss = {
	display: 'flex',
	alignItems: 'flex-start',
	gap: spacing.md,
	minWidth: 0,
}

const iconCss = {
	width: '3rem',
	height: '3rem',
	borderRadius: radius.md,
	objectFit: 'cover' as const,
	backgroundColor: colors.logoWell,
	flexShrink: 0,
}

const iconFallbackCss = {
	...iconCss,
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	fontWeight: typography.fontWeight.semibold,
	color: colors.primaryText,
	backgroundColor: colors.primarySoft,
}

const mutedCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const codeCss = {
	fontFamily: typography.fontFamilyMono,
	fontSize: typography.fontSize.sm,
	overflowWrap: 'anywhere' as const,
}

const sectionHeadingCss = {
	margin: 0,
	fontSize: typography.fontSize.base,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
}

const claimListCss = {
	margin: 0,
	paddingLeft: '1.15rem',
	display: 'grid',
	gap: spacing.xs,
	color: colors.text,
}
