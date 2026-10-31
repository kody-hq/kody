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
	const [selectedScopes, setSelectedScopes] = useState(
		// Optional credential needs start unchecked; the visitor opts in.
		() =>
			new Set(
				data.optionalScopes
					.map(({ scope }) => scope)
					.filter((scope) => !scope.startsWith('need:')),
			),
	)
	const [selectedCredentialIds, setSelectedCredentialIds] = useState(
		() =>
			Object.fromEntries(
				data.executorNeeds.flatMap((need) =>
					need.recommendedCredentialId
						? [[need.key, need.recommendedCredentialId]]
						: [],
				),
			) as Record<string, string>,
	)
	const missingRequiredCredential = data.executorNeeds.some(
		(need) =>
			need.required &&
			!need.credentials.some(
				(credential) => credential.id === selectedCredentialIds[need.key],
			),
	)
	const missingSelectedCredential = data.executorNeeds.some((need) => {
		const isSelected = needIsAsked(need)
		return (
			isSelected &&
			!need.credentials.some(
				(credential) => credential.id === selectedCredentialIds[need.key],
			)
		)
	})
	function needIsAsked(need: (typeof data.executorNeeds)[number]) {
		return (
			need.required ||
			selectedScopes.has(need.scope) ||
			data.alreadyAllowedScopes.includes(need.scope)
		)
	}
	const needIsMissing = (need: (typeof data.executorNeeds)[number]) =>
		needIsAsked(need) &&
		!need.credentials.some(
			(credential) => credential.id === selectedCredentialIds[need.key],
		)
	async function submit(decision: 'approve' | 'deny') {
		if (busy) return
		setBusy(true)
		setError(null)
		try {
			const credentialFields = Object.fromEntries(
				data.executorNeeds.flatMap((need) => {
					const selected = selectedCredentialIds[need.key]
					return selected
						? [[`credential_need:${encodeURIComponent(need.key)}`, selected]]
						: []
				}),
			)
			const fields = {
				...data.hiddenFields,
				...credentialFields,
				selected_scopes: [
					...data.requiredScopes,
					...data.alreadyAllowedScopes,
					...selectedScopes,
				].join(' '),
			}
			await send({ data: { fields, decision } })
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
		<AccountManagementShell layout="form" maxWidth="40rem">
			<AccountManagementHeader
				title={`Allow ${data.packageName}?`}
				description={`${data.packageName} wants to use your Kody account. Review what it can see, then allow or cancel.`}
			/>
			<section
				data-testid="package-app-oauth-consent"
				css={{ display: 'grid', gap: spacing.lg }}
			>
				{data.device ? (
					<section
						data-testid="package-app-oauth-device"
						css={deviceCss}
						aria-label="Sign-in on another device"
					>
						<h2 css={sectionHeadingCss}>Signing in on another device</h2>
						<p css={mutedCss}>
							Allowing signs that device in to {data.packageName} as you. You
							stay signed in here.
						</p>
						<dl css={deviceFactsCss}>
							<dt>Code on that device</dt>
							<dd>
								<code
									css={deviceCodeCss}
									data-testid="package-app-oauth-device-code"
								>
									{data.device.userCode}
								</code>
							</dd>
							<dt>Device</dt>
							<dd data-testid="package-app-oauth-device-requester">
								{data.device.requester}
							</dd>
						</dl>
						<p role="note" css={deviceWarningCss}>
							Only continue if you started this sign-in yourself on a device you
							control, and the code matches.
						</p>
					</section>
				) : null}
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
					<p css={mutedCss}>Required: {data.requiredLabels.join('; ')}</p>
					{data.alreadyAllowedLabels.length > 0 ? (
						<p css={mutedCss}>
							Already allowed: {data.alreadyAllowedLabels.join('; ')}
						</p>
					) : null}
					<div css={{ display: 'grid', gap: spacing.sm }}>
						{data.optionalScopes.map(({ scope, label }) => (
							<label key={scope} css={{ display: 'flex', gap: spacing.sm }}>
								<input
									type="checkbox"
									name="selected_scopes"
									value={scope}
									form="package-app-oauth-consent-form"
									checked={selectedScopes.has(scope)}
									onChange={(event) =>
										setSelectedScopes((current) => {
											const next = new Set(current)
											if (event.currentTarget.checked) next.add(scope)
											else next.delete(scope)
											return next
										})
									}
								/>
								<span>{label}</span>
							</label>
						))}
					</div>
					{data.optionalScopes.some(({ scope }) => scope === 'email') ? (
						<p css={mutedCss}>
							Email visibility does not grant permission to send email. If you
							revoke email access later, this app must stop using your address.
						</p>
					) : null}
				</section>
				{data.executorNeeds.map((need) => {
					const selected = selectedCredentialIds[need.key]
					const recommended = need.credentials.find(
						(credential) => credential.id === need.recommendedCredentialId,
					)
					const otherCandidates = need.credentials.filter(
						(credential) => credential.id !== need.recommendedCredentialId,
					)
					const missing = needIsMissing(need)
					const wanted = describeWantedCredential(need)
					return (
						<section
							key={need.key}
							aria-label={`Credentials for ${need.description}`}
							css={{ display: 'grid', gap: spacing.sm }}
						>
							<h2 css={sectionHeadingCss}>
								{need.required
									? 'Required credentials'
									: 'Optional credentials'}
							</h2>
							<p css={mutedCss}>{need.description}</p>
							<p css={mutedCss}>Needs {wanted}.</p>
							{missing ? (
								<p
									role="status"
									data-testid={`package-app-oauth-need-missing-${need.key}`}
									css={needMissingCss}
								>
									{need.required
										? `Required: create ${wanted} to allow this app. Allow stays off until you choose one.`
										: `Choose ${wanted} or turn off this optional permission to continue.`}
								</p>
							) : null}
							{recommended ? (
								<label css={credentialChoiceCss}>
									<input
										type="radio"
										name={`credential_need:${encodeURIComponent(need.key)}`}
										value={recommended.id}
										form="package-app-oauth-consent-form"
										checked={selected === recommended.id}
										onChange={() =>
											setSelectedCredentialIds((current) => ({
												...current,
												[need.key]: recommended.id,
											}))
										}
									/>
									<span>
										<strong>{recommended.name}</strong>
										<span css={mutedCss}>
											{' '}
											Used by {recommended.usedByApps} apps
										</span>
									</span>
								</label>
							) : (
								<p css={mutedCss}>
									No {need.provider} credential yet. Credentials without this
									provider are not listed.
								</p>
							)}
							{otherCandidates.length > 0 ? (
								// A native disclosure so the alternates work without page
								// JavaScript too.
								<details css={alternatesCss}>
									<summary>Choose another credential</summary>
									{otherCandidates.map((credential) => (
										<label key={credential.id} css={credentialChoiceCss}>
											<input
												type="radio"
												name={`credential_need:${encodeURIComponent(need.key)}`}
												value={credential.id}
												form="package-app-oauth-consent-form"
												checked={selected === credential.id}
												onChange={() =>
													setSelectedCredentialIds((current) => ({
														...current,
														[need.key]: credential.id,
													}))
												}
											/>
											<span>
												<strong>{credential.name}</strong>
												<span css={mutedCss}>
													{' '}
													Used by {credential.usedByApps} apps
												</span>
											</span>
										</label>
									))}
								</details>
							) : null}
							<p css={mutedCss}>
								<a
									href={need.createUrl}
									target="_blank"
									rel="noreferrer"
									data-testid={`package-app-oauth-need-create-${need.key}`}
								>
									Create {wanted}
								</a>
								{need.createDestination
									? ` in @${need.createDestination}`
									: null}{' '}
								(opens in a new tab; come back and reload this page to choose
								it).
							</p>
						</section>
					)
				})}

				<details
					data-testid="package-app-oauth-consent-details"
					css={accountDisclosureCss}
				>
					<summary>Details</summary>
					<MetadataGrid items={detailItems} />
				</details>

				<form
					id="package-app-oauth-consent-form"
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
					{[
						...new Set([...data.requiredScopes, ...data.alreadyAllowedScopes]),
					].map((scope) => (
						<input
							key={`selected:${scope}`}
							type="hidden"
							name="selected_scopes"
							value={scope}
						/>
					))}
					<button
						disabled={busy || missingSelectedCredential}
						type="submit"
						name="decision"
						value="approve"
						data-testid="package-app-oauth-approve"
						aria-describedby={
							missingSelectedCredential
								? 'package-app-oauth-allow-blocked'
								: undefined
						}
						css={[getPillButtonCss({ size: 'sm' }), allowBlockedCss]}
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
				{data.billing ? (
					<p css={mutedCss} data-testid="package-app-oauth-who-pays">
						{data.billing.payer === 'visitor-org'
							? `Who pays: this app belongs to another organization, so your org (@${data.billing.orgSlug}) pays for the metered work your visits cause, like storage reads, outbound fetches, and email. The publisher pays to run the app itself.`
							: 'Who pays: the publisher pays for what this app runs for you. Signing in does not charge you.'}
					</p>
				) : null}
				<p css={mutedCss} data-testid="package-app-oauth-owner-visibility">
					The app's owner can see that you connected, when you last used it, and
					what you allowed. They never see your credentials. You can revoke
					access anytime in Account &gt; Connected apps.
				</p>
				{missingSelectedCredential ? (
					<p id="package-app-oauth-allow-blocked" css={mutedCss}>
						{missingRequiredCredential
							? 'Allow is off until every required credential is chosen.'
							: 'Allow is off until each selected optional permission has a credential.'}
					</p>
				) : null}
				{error ? (
					<p role="alert" css={mutedCss}>
						{error}
					</p>
				) : null}
			</section>
		</AccountManagementShell>
	)
}

const deviceCss = {
	display: 'grid',
	gap: spacing.sm,
	padding: spacing.md,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.background,
}

const deviceFactsCss = {
	margin: 0,
	display: 'grid',
	gridTemplateColumns: 'max-content minmax(0, 1fr)',
	columnGap: spacing.md,
	rowGap: spacing.xs,
	alignItems: 'baseline',
	fontSize: typography.fontSize.sm,
	'& dt': { color: colors.textMuted },
	'& dd': { margin: 0, color: colors.text, overflowWrap: 'anywhere' as const },
}

const deviceCodeCss = {
	fontFamily: typography.fontFamilyMono,
	fontSize: typography.fontSize.lg,
	fontWeight: typography.fontWeight.semibold,
	letterSpacing: '0.12em',
	color: colors.text,
}

const deviceWarningCss = {
	margin: 0,
	padding: `${spacing.xs} ${spacing.sm}`,
	borderRadius: radius.md,
	borderLeft: `3px solid ${colors.warning}`,
	backgroundColor: colors.surface,
	color: colors.warningText,
	fontSize: typography.fontSize.sm,
}

const alternatesCss = {
	display: 'grid',
	gap: spacing.sm,
	'& > summary': {
		cursor: 'pointer',
		width: 'fit-content',
		color: colors.primaryText,
		fontSize: typography.fontSize.sm,
		fontWeight: typography.fontWeight.semibold,
	},
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

function describeWantedCredential(need: {
	provider: string
	kindLabel: string | null
}) {
	return need.kindLabel
		? `a ${need.provider} ${need.kindLabel} credential`
		: `a ${need.provider} credential`
}

const needMissingCss = {
	margin: 0,
	padding: `${spacing.xs} ${spacing.sm}`,
	borderRadius: radius.md,
	borderLeft: `3px solid ${colors.warning}`,
	backgroundColor: colors.surface,
	color: colors.warningText,
	fontSize: typography.fontSize.sm,
}

const allowBlockedCss = {
	'&:disabled': {
		opacity: 0.4,
		filter: 'grayscale(1)',
		boxShadow: 'none',
	},
}

const credentialChoiceCss = {
	display: 'flex',
	alignItems: 'flex-start',
	gap: spacing.sm,
}
