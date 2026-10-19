/** @jsxImportSource @emotion/react */
import { SiteLink } from '../components/site-link.tsx'

import { css } from '@emotion/react'
import { type ReactNode } from 'react'
import {
	IdValue,
	MetadataGrid,
	TimestampValue,
} from './account-management-components.tsx'
import { CredentialHostsEditor } from './account-credential-hosts-editor.tsx'
import { CredentialFillPlacementEditor } from './account-credential-fill-placement-editor.tsx'
import { RecordChips, recordBodyCss } from './record-table.tsx'
import { formatFillPlacementSummary } from '#universal/credential-fill-placement.ts'
import {
	type CredentialInjectView,
	type CredentialListItem,
} from '#universal/credential-contracts.ts'
import {
	type AccountCredentialDetail,
	type CredentialNeedFit,
	credentialKindLabel,
	credentialStatusLabel,
} from '#universal/credentials-list.ts'
import {
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getGhostButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
const codeCss = css({
	fontFamily: 'monospace',
	fontSize: typography.fontSize.sm,
	overflowWrap: 'anywhere',
})
const listCss = css({
	margin: 0,
	paddingLeft: '1.1rem',
	display: 'grid',
	gap: spacing.xs,
	color: colors.text,
})
const mutedCss = css({ margin: 0, color: colors.textMuted })
/** What a credential of each kind is, in one sentence. */
function kindLede(kind: CredentialListItem['kind']) {
	switch (kind) {
		case 'secret':
			return 'A key. Kody places its value on requests to the hosts below, so code never sees it.'
		case 'oauth':
			return 'An OAuth connection. Kody keeps its token fresh and places it on requests to the provider’s hosts.'
		case 'mcp':
			return 'An MCP server. Kody connects to it and offers its tools to agents and packages.'
		case 'url':
			return 'A secret URL, such as a webhook URL with a token in it. Requests go only to that URL.'
		case 'login':
			return 'A login. Kody exchanges it for a session token and places the token on requests.'
		case 'signing':
			return 'A signing key. Kody signs requests with it inside the platform; the key never goes on the wire.'
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}
function injectLabel(inject: CredentialInjectView) {
	switch (inject.kind) {
		case 'header':
			return `${inject.name}: ${inject.format}`
		case 'basic':
			return `Basic auth, value as the ${inject.valueAs}`
		case 'query':
			return `Query parameter ${inject.param}={value}`
		default: {
			const exhaustive: never = inject
			return exhaustive
		}
	}
}
/** How a scoped credential() client places the value, or why it never does. */
function injectSummary(credential: CredentialListItem) {
	switch (credential.kind) {
		case 'secret':
		case 'oauth':
		case 'login':
			return credential.inject
				? injectLabel(credential.inject)
				: 'Set by each request'
		case 'url':
			return 'The URL is the request target'
		case 'signing':
			return 'Signs requests; never placed on one'
		case 'mcp':
			return 'Kody’s MCP connection'
		default: {
			const exhaustive: never = credential.kind
			return exhaustive
		}
	}
}

function showsFillPlacement(kind: CredentialListItem['kind']) {
	switch (kind) {
		case 'secret':
		case 'oauth':
		case 'url':
		case 'login':
		case 'signing':
			return true
		case 'mcp':
			return false
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}
function hostsHint(credential: CredentialListItem) {
	if (credential.hosts.length > 0) return null
	switch (credential.kind) {
		case 'secret':
		case 'url':
		case 'login':
			return 'No hosts approved yet. Kody sends it nowhere until a host is approved.'
		case 'signing':
			return 'No hosts approved yet. Kody signs nothing until a host is approved.'
		case 'oauth':
			return 'The provider’s API hosts are not known yet.'
		case 'mcp':
			return null
		default: {
			const exhaustive: never = credential.kind
			return exhaustive
		}
	}
}
function renderUsageGaps(detail: AccountCredentialDetail) {
	return (
		<>
			{detail.usageTruncated ? (
				<p css={mutedCss}>
					Only the most recently updated packages are checked.
				</p>
			) : null}
			{detail.usageUnreadable > 0 ? (
				<p css={mutedCss}>
					{detail.usageUnreadable === 1
						? '1 package could not be checked.'
						: `${detail.usageUnreadable} packages could not be checked.`}
				</p>
			) : null}
		</>
	)
}
function fitLabel(fit: CredentialNeedFit) {
	switch (fit) {
		case 'auto':
			return 'Only match; picked unless a mapping chooses another'
		case 'candidate':
			return 'One of several matches; needs a mapping'
		case 'possible':
			return 'Same kind with no provider; can be mapped'
		default: {
			const exhaustive: never = fit
			return exhaustive
		}
	}
}
function editLabel(kind: CredentialListItem['kind']) {
	switch (kind) {
		case 'secret':
		case 'url':
		case 'login':
		case 'signing':
			return 'Edit'
		case 'oauth':
			return 'Manage connection'
		case 'mcp':
			return 'Manage server'
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}
function packageName(
	id: string,
	packagesById: ReadonlyMap<
		string,
		{
			kodyId: string
		}
	>,
) {
	return packagesById.get(id)?.kodyId ?? id
}
function renderField(label: string, body: ReactNode) {
	return (
		<div css={fieldCss}>
			<span css={fieldLabelCss}>{label}</span>
			{body}
		</div>
	)
}
export function renderCredentialDetail(input: {
	credential: CredentialListItem
	detail: AccountCredentialDetail | null
	manageHref: string
	teamOrg: boolean
	packagesById: ReadonlyMap<string, { kodyId: string }>
	/** The organization whose credential is being edited. */
	orgSlug: string
}) {
	const { credential, detail, packagesById } = input
	const lockedTo = credential.lockedToPackageIds.map((id) =>
		packageName(id, packagesById),
	)
	const hint = hostsHint(credential)
	const hasExpiry = credential.kind !== 'oauth' && credential.kind !== 'mcp'
	return (
		<section aria-label={`${credential.name} details`} css={recordBodyCss}>
			<div css={{ display: 'grid', gap: spacing.xs }}>
				<h2 css={cardTitleCss}>{credential.name}</h2>
				<p css={descriptionCss}>{kindLede(credential.kind)}</p>
				{credential.description ? (
					<p css={{ margin: 0, color: colors.text }}>
						{credential.description}
					</p>
				) : null}
			</div>

			<MetadataGrid
				items={[
					{ label: 'Kind', value: credentialKindLabel(credential.kind) },
					{
						label: 'Owner',
						value:
							credential.scope === 'personal'
								? 'Personal (yours, granted to this org)'
								: input.teamOrg
									? 'Org'
									: 'Personal',
					},
					{ label: 'Provider', value: credential.provider ?? 'None' },
					{
						label: 'Status',
						value: credential.statusMessage
							? `${credentialStatusLabel(credential.status)}: ${credential.statusMessage}`
							: credentialStatusLabel(credential.status),
					},
					...(hasExpiry
						? [
								{
									label: 'Expires',
									value: credential.expiresAt ? (
										<TimestampValue value={credential.expiresAt} />
									) : (
										'Never'
									),
								},
							]
						: []),
					{
						label: 'Created',
						value: <TimestampValue value={credential.createdAt} />,
					},
					{
						label: 'Updated',
						value: <TimestampValue value={credential.updatedAt} />,
					},
					{
						label: 'Credential id',
						value: <IdValue value={credential.id} label="credential id" />,
					},
				]}
			/>

			{credential.mcp
				? renderField(
						'Server URL',
						<code css={codeCss}>{credential.mcp.url}</code>,
					)
				: null}

			{renderField(
				'Hosts',
				<div css={css({ display: 'grid', gap: spacing.sm })}>
					{hint ? (
						<p css={mutedCss}>{hint}</p>
					) : (
						<RecordChips items={credential.hosts} empty="—" />
					)}
					{detail?.hostSettings ? (
						<CredentialHostsEditor
							key={credential.id}
							credentialId={credential.id}
							credentialName={credential.name}
							settings={detail.hostSettings}
							orgSlug={input.orgSlug}
						/>
					) : null}
				</div>,
			)}

			{renderField(
				'Inject',
				<div css={{ display: 'grid', gap: spacing.xs }}>
					<code css={codeCss}>{injectSummary(credential)}</code>
					<p css={mutedCss}>
						How a scoped <code css={codeCss}>credential()</code> client puts
						this value on a request. Placeholders ignore inject.
					</p>
				</div>,
			)}

			{showsFillPlacement(credential.kind)
				? renderField(
						'Fill placement',
						<div css={{ display: 'grid', gap: spacing.xs }}>
							{credential.scope === 'org' ? (
								<CredentialFillPlacementEditor
									key={`${credential.id}:placement`}
									credentialId={credential.id}
									placement={credential.placement}
									orgSlug={input.orgSlug}
								/>
							) : (
								<>
									<code css={codeCss}>
										{formatFillPlacementSummary(credential.placement)}
									</code>
									<p css={mutedCss}>
										Where placeholders may be filled. Edit this in the personal
										org that owns the credential.
									</p>
								</>
							)}
							{detail?.placeholder ? (
								<p css={mutedCss}>
									Code can write <code css={codeCss}>{detail.placeholder}</code>{' '}
									in a request to one of its hosts; Kody fills it over HTTPS
									into the parts above.
								</p>
							) : null}
						</div>,
					)
				: null}

			{renderField(
				'Packages',
				<p css={{ margin: 0, color: colors.text }}>
					{credential.packageId
						? `Belongs to ${packageName(credential.packageId, packagesById)}. Only that package’s runs can use it.`
						: lockedTo.length > 0
							? `Locked to ${lockedTo.join(', ')}. Other packages cannot use it.`
							: 'Not locked to specific packages.'}
				</p>,
			)}

			{credential.scope === 'personal' || !input.teamOrg
				? renderField(
						'Shared with',
						detail === null ? (
							<p css={mutedCss}>Loading…</p>
						) : detail.grants.length === 0 ? (
							<p css={mutedCss}>Not granted to any team org.</p>
						) : (
							<ul css={listCss}>
								{detail.grants.map((grant) => (
									<li key={grant.orgSlug}>
										{grant.orgName} (@{grant.orgSlug}) since{' '}
										<TimestampValue value={grant.grantedAt} />
									</li>
								))}
							</ul>
						),
					)
				: null}

			{renderField(
				'Used by',
				detail === null ? (
					<p css={mutedCss}>Loading…</p>
				) : credential.packageId ? (
					detail.usage.length === 0 ? (
						<p css={mutedCss}>
							Only {packageName(credential.packageId, packagesById)}, through
							its placeholders and that package’s declared needs when the Key’s
							name matches a need (or it is the only match).
						</p>
					) : (
						<div css={{ display: 'grid', gap: spacing.xs }}>
							<p css={mutedCss}>
								Fills needs on {packageName(credential.packageId, packagesById)}{' '}
								(and its placeholders):
							</p>
							<ul css={listCss}>
								{detail.usage.map((use) => (
									<li key={`${use.packageId}:${use.needKey}`}>
										<code css={codeCss}>
											{use.kodyId} · {use.needKey}
										</code>{' '}
										<span css={{ color: colors.textMuted }}>
											{fitLabel(use.fit)}
										</span>
									</li>
								))}
							</ul>
							{renderUsageGaps(detail)}
						</div>
					)
				) : detail.usage.length === 0 ? (
					<div css={{ display: 'grid', gap: spacing.xs }}>
						<p css={mutedCss}>
							No package in this org declares a need this credential fills
							{credential.status === 'ok'
								? '.'
								: ' while it needs attention. Fix it and runs can pick it again.'}
						</p>
						{renderUsageGaps(detail)}
					</div>
				) : (
					<div css={{ display: 'grid', gap: spacing.xs }}>
						<ul css={listCss}>
							{detail.usage.map((use) => (
								<li key={`${use.packageId}:${use.needKey}`}>
									<code css={codeCss}>
										{use.kodyId} · {use.needKey}
									</code>{' '}
									<span css={{ color: colors.textMuted }}>
										{fitLabel(use.fit)}
									</span>
								</li>
							))}
						</ul>
						{renderUsageGaps(detail)}
					</div>
				),
			)}

			<p css={mutedCss}>Values never appear here.</p>

			<div>
				<SiteLink
					href={input.manageHref}
					css={getGhostButtonCss({ size: 'sm' })}
				>
					{editLabel(credential.kind)}
				</SiteLink>
			</div>
		</section>
	)
}
