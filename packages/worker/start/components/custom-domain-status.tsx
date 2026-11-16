/** @jsxImportSource @emotion/react */
import { Badge } from './badge.tsx'
import { TextLink } from './text-link.tsx'
import type { CSSObject } from '@emotion/react'
import type {
	PackageAppCustomDomainRecordView,
	PackageAppCustomDomainStatus,
	PackageAppCustomDomainView,
} from '#universal/package-app-custom-domain-status.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

const stateLabels: Record<PackageAppCustomDomainStatus['state'], string> = {
	pending: 'Pending',
	active: 'Active',
	needs_attention: 'Needs attention',
}

export function CustomDomainStatusBadge({
	status,
}: {
	status: PackageAppCustomDomainStatus
}) {
	const tone =
		status.state === 'active'
			? 'accent'
			: status.state === 'needs_attention'
				? 'warning'
				: 'neutral'
	return (
		<Badge tone={tone} data-custom-domain-state={status.state}>
			{stateLabels[status.state]}
		</Badge>
	)
}

/**
 * DNS records to publish. Shown only while a hostname is not active, so an
 * active domain stays a one-line status.
 */
export function CustomDomainRecords({
	records,
}: {
	records: ReadonlyArray<PackageAppCustomDomainRecordView>
}) {
	if (!records.length) return null
	return (
		<div css={recordsWrapCss}>
			<p css={recordsNoteCss}>
				Add these records at your DNS provider. Set each one to{' '}
				<strong>DNS only</strong> (proxy off, grey cloud in Cloudflare).
			</p>
			<table css={recordsTableCss}>
				<thead>
					<tr>
						<th scope="col">Type</th>
						<th scope="col">Name</th>
						<th scope="col">Value</th>
					</tr>
				</thead>
				<tbody>
					{records.map((record) => (
						<tr key={`${record.type}:${record.name}:${record.value}`}>
							<td>{record.type}</td>
							<td>
								<code>{record.relativeName}</code>
								{record.name !== record.relativeName ? (
									<span css={recordFullNameCss}>
										Full name: <code>{record.name}</code>
									</span>
								) : null}
							</td>
							<td>
								<code>{record.value}</code>
							</td>
						</tr>
					))}
				</tbody>
			</table>
			<p css={recordsNoteCss}>
				Names are shown without your domain. Some providers want the full name
				instead, shown under each name.
			</p>
		</div>
	)
}

function formatCheckedAt(iso: string) {
	const ms = Date.parse(iso)
	if (!Number.isFinite(ms)) return null
	return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

/**
 * Status of one custom hostname: badge, plain reason, and (while not active)
 * the records to publish. Kody re-checks pending hostnames itself, so there
 * is no refresh control here.
 */
function CustomDomainSummary({
	domain,
}: {
	domain: PackageAppCustomDomainView
}) {
	const active = domain.status.state === 'active'
	const checkedAt = formatCheckedAt(domain.lastCheckedAt)
	return (
		<li css={domainRowCss} data-testid={`custom-domain-${domain.id}`}>
			<div css={domainHeadCss}>
				{active ? (
					<TextLink
						reloadDocument
						css={hostnameCss}
						href={`https://${domain.hostname}/`}
						target="_blank"
						rel="noreferrer"
					>
						{domain.hostname}
					</TextLink>
				) : (
					<span css={hostnameCss}>{domain.hostname}</span>
				)}
				<CustomDomainStatusBadge status={domain.status} />
			</div>
			{domain.status.reason ? (
				<p
					css={
						domain.status.state === 'needs_attention'
							? attentionReasonCss
							: reasonCss
					}
				>
					{domain.status.reason}
				</p>
			) : null}
			{active ? null : <CustomDomainRecords records={domain.records} />}
			{checkedAt ? (
				<p css={checkedCss}>
					{active ? 'Last checked' : 'Kody last checked'} {checkedAt}
				</p>
			) : null}
		</li>
	)
}

export function PackageCustomDomainsSection({
	domains,
	manageHref,
}: {
	domains: ReadonlyArray<PackageAppCustomDomainView>
	manageHref: string | null
}) {
	if (!domains.length) return null
	return (
		<section
			css={sectionCss}
			data-testid="package-custom-domains"
			aria-labelledby="package-custom-domains-heading"
		>
			<h3 id="package-custom-domains-heading" css={headingCss}>
				Custom domain
			</h3>
			<ul css={listCss}>
				{domains.map((domain) => (
					<CustomDomainSummary key={domain.id} domain={domain} />
				))}
			</ul>
			<p css={checkedCss}>
				Kody checks pending domains every few minutes and emails the owners when
				one goes live.{' '}
				{manageHref ? (
					<TextLink reloadDocument href={manageHref}>
						Manage custom domains
					</TextLink>
				) : null}
			</p>
		</section>
	)
}

const sectionCss: CSSObject = { display: 'grid', gap: spacing.md }

const headingCss: CSSObject = {
	margin: 0,
	fontSize: typography.fontSize.base,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
}

const listCss: CSSObject = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.md,
}

const domainRowCss: CSSObject = {
	display: 'grid',
	gap: spacing.xs,
	minWidth: 0,
}

const domainHeadCss: CSSObject = {
	display: 'flex',
	flexWrap: 'wrap',
	alignItems: 'center',
	gap: spacing.sm,
}

const hostnameCss: CSSObject = {
	fontFamily: typography.fontFamilyMono,
	color: colors.text,
	overflowWrap: 'anywhere',
}

const reasonCss: CSSObject = {
	margin: 0,
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
	lineHeight: 1.5,
}

const attentionReasonCss: CSSObject = {
	...reasonCss,
	color: colors.warningText,
}

const checkedCss: CSSObject = {
	margin: 0,
	fontSize: typography.fontSize.xs,
	color: colors.textMuted,
}

const recordsWrapCss: CSSObject = {
	display: 'grid',
	gap: spacing.xs,
	minWidth: 0,
	overflowX: 'auto',
}

const recordsNoteCss: CSSObject = {
	margin: 0,
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
}

const recordFullNameCss: CSSObject = {
	display: 'block',
	marginTop: '0.125rem',
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
	overflowWrap: 'anywhere',
}

const recordsTableCss: CSSObject = {
	width: '100%',
	borderCollapse: 'collapse',
	fontSize: typography.fontSize.sm,
	'th, td': {
		textAlign: 'left',
		padding: `${spacing.xs} ${spacing.sm}`,
		borderBottom: `1px solid ${colors.border}`,
		verticalAlign: 'top',
	},
	th: { color: colors.textMuted, fontWeight: typography.fontWeight.medium },
	code: {
		fontFamily: typography.fontFamilyMono,
		color: colors.text,
		overflowWrap: 'anywhere',
	},
}
