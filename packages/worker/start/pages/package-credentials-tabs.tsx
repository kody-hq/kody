/** @jsxImportSource @emotion/react */
import { SiteLink } from '../components/site-link.tsx'

import { type ReactNode } from 'react'
import {
	type CredentialMappingTarget,
	type CredentialRef,
	type PackageCredentialsEnablementAction,
	type EffectiveCredentialMapping,
	type PackageCredentialNeedView,
	type PackageCredentialsView,
	type PackageTriggerView,
	type StoredCredentialMapping,
} from '#universal/credential-contracts.ts'
import { credentialKindLabel } from '#universal/credentials-list.ts'
import {
	credentialRefHref,
	credentialRefLabel,
	describeIncompleteMapping,
	incompleteMappingTab,
	type MappingStatusTone,
	mappingSourceLabel,
	mappingStatusLabel,
	packageCredentialsTabHref,
	packageCredentialsTabLabel,
	type PackageCredentialsTab,
	sortNeedsByAttention,
} from '#universal/package-credentials-page.ts'
import {
	cardCss,
	cardTitleCss,
	insetCardCss,
	sectionTitleCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
/** One stored mapping a person may edit: a default layer or a trigger override. */
export type MappingCellInput = {
	target: CredentialMappingTarget
	need: PackageCredentialNeedView
	stored: StoredCredentialMapping | null
	inheritLabel: string
	editable: boolean
	trigger: PackageTriggerView | null
}
type TriggerEnablementActionInput = PackageCredentialsEnablementAction

export type PackageTabContext = {
	orgSlug: string
	username: string
	kodyId: string
	view: PackageCredentialsView
	/** Renders an editable cell; without it, cells are read-only. */
	renderMappingCell?: (input: MappingCellInput) => ReactNode
	setTriggerEnablement?: (input: TriggerEnablementActionInput) => void
	enablementBusyKey?: string | null
	enablementError?: string | null
}
export function renderMappingCell(
	context: PackageTabContext,
	input: MappingCellInput,
) {
	return context.renderMappingCell
		? context.renderMappingCell(input)
		: renderStored(context.orgSlug, input.stored, input.inheritLabel)
}
export const mutedCss = { margin: 0, color: colors.textMuted }
const listCss = {
	margin: 0,
	padding: 0,
	listStyle: 'none',
	display: 'grid',
	gap: spacing.sm,
}
export const rowCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'baseline',
	gap: spacing.sm,
}
export const tableCss = {
	width: '100%',
	borderCollapse: 'collapse' as const,
	fontSize: typography.fontSize.sm,
	'& th': {
		textAlign: 'left' as const,
		fontWeight: typography.fontWeight.semibold,
		color: colors.textMuted,
		padding: `${spacing.xs} ${spacing.sm}`,
		borderBottom: `1px solid ${colors.border}`,
	},
	'& td': {
		padding: spacing.sm,
		borderBottom: `1px solid ${colors.border}`,
		verticalAlign: 'top' as const,
	},
}
function toneColor(tone: MappingStatusTone) {
	switch (tone) {
		case 'ok':
			return colors.text
		case 'muted':
			return colors.textMuted
		case 'warning':
			return colors.warningText
		case 'danger':
			return colors.danger
		default: {
			const exhaustive: never = tone
			return exhaustive
		}
	}
}
export function renderStatus(mapping: EffectiveCredentialMapping) {
	const { label, tone } = mappingStatusLabel(mapping.status)
	return (
		<span
			data-mapping-status={mapping.status}
			css={{
				display: 'inline-flex',
				padding: `0 ${spacing.sm}`,
				borderRadius: radius.full,
				border: `1px solid ${tone === 'ok' ? colors.border : toneColor(tone)}`,
				color: toneColor(tone),
				fontSize: typography.fontSize.xs,
				fontWeight: typography.fontWeight.semibold,
				whiteSpace: 'nowrap',
			}}
		>
			{label}
		</span>
	)
}
function renderRefs(orgSlug: string, refs: ReadonlyArray<CredentialRef>) {
	if (refs.length === 0) return <span css={mutedCss}>—</span>
	return (
		<span css={{ display: 'inline-flex', flexWrap: 'wrap', gap: spacing.xs }}>
			{refs.map((ref, index) => (
				<span key={ref.id}>
					<SiteLink href={credentialRefHref(orgSlug, ref)}>
						{credentialRefLabel(ref)}
					</SiteLink>
					{index < refs.length - 1 ? ',' : ''}
				</span>
			))}
		</span>
	)
}
/** What a run would use for a need: its refs, or the candidates to pick from. */
export function renderEffective(
	orgSlug: string,
	mapping: EffectiveCredentialMapping,
) {
	switch (mapping.status) {
		case 'ready':
			return renderRefs(orgSlug, mapping.credentials)
		case 'none':
			return <span css={mutedCss}>Nothing, on purpose</span>
		case 'unbound':
			return <span css={mutedCss}>No matching credential</span>
		case 'ambiguous':
			return <span>One of: {renderRefs(orgSlug, mapping.candidates)}</span>
		case 'unusable':
			return (
				<span css={{ color: colors.danger }}>
					A mapped credential can no longer be used
				</span>
			)
		default: {
			const exhaustive: never = mapping.status
			return exhaustive
		}
	}
}
export function renderStored(
	orgSlug: string,
	stored: StoredCredentialMapping | null,
	inheritLabel: string,
) {
	if (!stored) return <span css={mutedCss}>{inheritLabel}</span>
	if (stored.credentials.length === 0 && stored.unusableIds.length === 0) {
		return <span css={mutedCss}>None on purpose</span>
	}
	return (
		<span css={rowCss}>
			{renderRefs(orgSlug, stored.credentials)}
			{stored.unusableIds.length > 0 ? (
				<span css={{ color: colors.danger }}>
					({stored.unusableIds.length} can no longer be used)
				</span>
			) : null}
			{stored.updatedBy ? (
				<span css={mutedCss}>set by @{stored.updatedBy.username}</span>
			) : null}
		</span>
	)
}
function needSummary(need: PackageCredentialNeedView) {
	const kind = need.kind ? credentialKindLabel(need.kind) : 'Any kind'
	const parts = [kind, need.provider]
	if (need.multiple) parts.push('several allowed')
	if (need.from) parts.push(`from ${need.from}`)
	return parts.join(' · ')
}
export const tabBodyCss = { display: 'grid', gap: spacing.md }
/** Every incomplete mapping on Credentials; on the other tabs, only the ones that tab fixes. */
export function renderIncomplete(
	context: PackageTabContext,
	currentTab: PackageCredentialsTab,
) {
	const { view } = context
	const items =
		currentTab === 'credentials'
			? view.incomplete
			: view.incomplete.filter(
					(item) => incompleteMappingTab(item) === currentTab,
				)
	if (items.length === 0) return null
	const needs = new Map(view.needs.map((need) => [need.key, need]))
	return (
		<section
			aria-labelledby="package-credentials-incomplete"
			data-testid="package-credentials-incomplete"
			css={{
				...cardCss,
				borderColor: colors.warning,
				borderLeft: `4px solid ${colors.warning}`,
			}}
		>
			<h2 id="package-credentials-incomplete" css={cardTitleCss}>
				{items.length === 1
					? '1 mapping needs attention'
					: `${items.length} mappings need attention`}
			</h2>
			<ul css={listCss}>
				{items.map((item) => {
					const tab = incompleteMappingTab(item)
					const createUrl = needs.get(item.needKey)?.createUrl
					const key = `${item.needKey}:${item.where.type === 'trigger' ? `${item.where.trigger.kind}:${item.where.trigger.name}` : 'default'}`
					return (
						<li key={key} css={{ display: 'grid', gap: spacing.xs }}>
							<span>{describeIncompleteMapping(item)}</span>
							<span css={rowCss}>
								{tab === currentTab ? null : (
									<SiteLink
										href={packageCredentialsTabHref({
											username: context.username,
											kodyId: context.kodyId,
											tab,
										})}
									>
										Open {packageCredentialsTabLabel(tab)}
									</SiteLink>
								)}
								{item.status === 'unbound' && createUrl ? (
									<SiteLink href={createUrl}>Add a credential</SiteLink>
								) : null}
							</span>
						</li>
					)
				})}
			</ul>
		</section>
	)
}
export function renderCredentialsTab(context: PackageTabContext): ReactNode {
	const { view, orgSlug } = context
	const needs = sortNeedsByAttention(view.needs)
	return (
		<div css={tabBodyCss}>
			{renderIncomplete(context, 'credentials')}
			<section
				aria-labelledby="package-credentials-used"
				css={cardCss}
				data-testid="package-credentials-used"
			>
				<h2 id="package-credentials-used" css={cardTitleCss}>
					Used by this package
				</h2>
				{needs.length === 0 ? (
					<p css={mutedCss}>
						This package declares no credentials. A package lists what it needs
						in <code>kody.credentials</code>.
					</p>
				) : (
					<div css={{ overflowX: 'auto' }}>
						<table css={tableCss}>
							<thead>
								<tr>
									<th scope="col">Need</th>
									<th scope="col">Uses</th>
									<th scope="col">From</th>
									<th scope="col">Status</th>
								</tr>
							</thead>
							<tbody>
								{needs.map((need) => (
									<tr key={need.key} data-testid={`package-need-${need.key}`}>
										<td>
											<strong>{need.key}</strong>
											<div css={mutedCss}>{needSummary(need)}</div>
											{need.description ? (
												<div css={mutedCss}>{need.description}</div>
											) : null}
										</td>
										<td>{renderEffective(orgSlug, need.effective)}</td>
										<td>{mappingSourceLabel(need.effective.source)}</td>
										<td>{renderStatus(need.effective)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				{view.triggers.length > 0 ? (
					<p css={mutedCss}>
						Triggers can map their own credentials. See{' '}
						<SiteLink
							href={packageCredentialsTabHref({
								username: context.username,
								kodyId: context.kodyId,
								tab: 'triggers',
							})}
						>
							Triggers
						</SiteLink>
						.
					</p>
				) : null}
			</section>
			<section
				aria-labelledby="package-credentials-locked"
				css={cardCss}
				data-testid="package-credentials-locked"
			>
				<h2 id="package-credentials-locked" css={cardTitleCss}>
					Locked to this package
				</h2>
				{view.locked.length === 0 ? (
					<p css={mutedCss}>
						No credential is locked to this package. Locking one from its detail
						pane keeps every other package from using it.
					</p>
				) : (
					<ul css={listCss}>
						{view.locked.map((credential) => (
							<li key={credential.id} css={rowCss}>
								<SiteLink
									href={credentialRefHref(orgSlug, {
										id: credential.id,
										name: credential.name,
										scope: credential.scope,
										kind: credential.kind,
									})}
								>
									{credential.name}
								</SiteLink>
								<span css={mutedCss}>
									{credentialKindLabel(credential.kind)}
									{credential.packageId ? ' · package Key' : ''}
									{credential.hosts.length > 0
										? ` · ${credential.hosts.join(', ')}`
										: ''}
								</span>
							</li>
						))}
					</ul>
				)}
			</section>
		</div>
	)
}
export function renderMappingsTab(context: PackageTabContext): ReactNode {
	const { view, orgSlug } = context
	if (view.needs.length === 0) {
		return (
			<section css={cardCss}>
				<p css={mutedCss}>
					This package declares no credentials, so it has no default mappings.
				</p>
			</section>
		)
	}
	return (
		<div css={tabBodyCss}>
			{renderIncomplete(context, 'mappings')}
			<p css={mutedCss}>
				Default mappings pick the credential each need uses when you run the
				package yourself. Your default wins over the org default; with neither,
				Kody uses the only credential that matches.
			</p>
			{view.needs.map((need) => (
				<section
					key={need.key}
					aria-labelledby={`package-mapping-${need.key}`}
					data-testid={`package-mapping-${need.key}`}
					css={cardCss}
				>
					<div css={{ display: 'grid', gap: spacing.xs }}>
						<h2 id={`package-mapping-${need.key}`} css={cardTitleCss}>
							{need.key}
						</h2>
						<p css={mutedCss}>{needSummary(need)}</p>
						{need.description ? <p css={mutedCss}>{need.description}</p> : null}
					</div>
					<dl css={{ margin: 0, display: 'grid', gap: spacing.sm }}>
						<div css={insetCardCss}>
							<dt css={sectionTitleCss}>Org default</dt>
							<dd css={{ margin: 0 }}>
								{renderMappingCell(context, {
									target: { type: 'default', layer: 'org' },
									need,
									stored: need.defaults.org,
									inheritLabel: 'Not set',
									editable: view.package.canManage,
									trigger: null,
								})}
							</dd>
						</div>
						<div css={insetCardCss}>
							<dt css={sectionTitleCss}>Your default</dt>
							<dd css={{ margin: 0 }}>
								{renderMappingCell(context, {
									target: { type: 'default', layer: 'mine' },
									need,
									stored: need.defaults.mine,
									inheritLabel: 'Not set (uses the org default)',
									editable: true,
									trigger: null,
								})}
							</dd>
						</div>
						<div css={insetCardCss}>
							<dt css={sectionTitleCss}>Your runs use</dt>
							<dd css={{ ...rowCss, margin: 0 }}>
								{renderEffective(orgSlug, need.effective)}
								<span css={mutedCss}>
									{mappingSourceLabel(need.effective.source)}
								</span>
								{renderStatus(need.effective)}
							</dd>
						</div>
					</dl>
					<SiteLink href={need.createUrl}>
						Add a credential for {need.key}
					</SiteLink>
				</section>
			))}
		</div>
	)
}
