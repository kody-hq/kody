/** @jsxImportSource @emotion/react */
import { formatTimestamp } from '../components/local-timestamp.tsx'
import { AccountManagementPanel } from './account-management-components.tsx'
import { recordStampCss } from './record-table.tsx'
import type { PackageAppCpuSummary } from '#universal/package-app-cpu-samples.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

function formatSampleMs(value: number) {
	if (value >= 1000) return `${(value / 1000).toFixed(2)} s`
	if (value >= 10) return `${Math.round(value)} ms`
	return `${value.toFixed(1)} ms`
}

const cellCss = {
	padding: `${spacing.xs} ${spacing.sm}`,
	textAlign: 'right' as const,
	fontVariantNumeric: 'tabular-nums',
	whiteSpace: 'nowrap' as const,
}

const headCellCss = {
	...cellCss,
	color: colors.textMuted,
	fontWeight: typography.fontWeight.medium,
	borderBottom: `1px solid ${colors.border}`,
}

const mutedTextCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

export function AccountActivityAppPerformance({
	performance,
}: {
	performance: PackageAppCpuSummary
}) {
	const warmPercent = Math.round(performance.warmSampleRate * 100)
	return (
		<AccountManagementPanel
			title="App performance (sampled)"
			description={`CPU and wall time for package app requests in the last ${performance.retentionDays} days. Every cold request (the first on a new isolate) and about ${warmPercent}% of warm requests are sampled. Match a request by its x-kody-request-id response header. Not billed and not counted toward plan limits.`}
			ariaLabel="App performance"
		>
			{performance.apps.length === 0 ? (
				<p css={mutedTextCss}>
					No sampled app requests in the last {performance.retentionDays} days.
				</p>
			) : (
				<div css={{ display: 'grid', gap: spacing.md }}>
					<div css={{ overflowX: 'auto' }}>
						<table
							css={{
								width: '100%',
								borderCollapse: 'collapse',
								fontSize: typography.fontSize.sm,
							}}
						>
							<thead>
								<tr>
									<th css={{ ...headCellCss, textAlign: 'left' }}>App</th>
									<th css={headCellCss}>Samples (cold)</th>
									<th css={headCellCss}>CPU p50</th>
									<th css={headCellCss}>CPU p95</th>
									<th css={headCellCss}>Wall p50</th>
									<th css={headCellCss}>Wall p95</th>
								</tr>
							</thead>
							<tbody>
								{performance.apps.map((app) => (
									<tr key={app.packageId}>
										<td
											css={{
												...cellCss,
												textAlign: 'left',
												fontWeight: typography.fontWeight.medium,
												color: colors.text,
											}}
										>
											{app.packageName ?? app.packageId}
										</td>
										<td css={cellCss}>
											{app.samples} ({app.coldSamples})
										</td>
										<td css={cellCss}>{formatSampleMs(app.cpuP50Ms)}</td>
										<td css={cellCss}>{formatSampleMs(app.cpuP95Ms)}</td>
										<td css={cellCss}>{formatSampleMs(app.wallP50Ms)}</td>
										<td css={cellCss}>{formatSampleMs(app.wallP95Ms)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					<div css={{ display: 'grid', gap: spacing.xs }}>
						<h3
							css={{
								margin: 0,
								fontSize: typography.fontSize.base,
								color: colors.text,
							}}
						>
							Slowest cold requests
						</h3>
						{performance.slowColdRequests.length === 0 ? (
							<p css={mutedTextCss}>No cold requests sampled yet.</p>
						) : (
							<ul
								css={{
									listStyle: 'none',
									margin: 0,
									padding: 0,
									display: 'grid',
									gap: spacing.xs,
								}}
							>
								{performance.slowColdRequests.map((sample) => (
									<li
										key={sample.requestId}
										css={{
											display: 'grid',
											gap: '0.25rem',
											padding: `${spacing.sm} ${spacing.md}`,
											border: `1px solid ${colors.border}`,
											borderRadius: radius.md,
											backgroundColor: colors.surface,
										}}
									>
										<span
											css={{
												display: 'flex',
												flexWrap: 'wrap',
												alignItems: 'baseline',
												gap: spacing.sm,
												minWidth: 0,
											}}
										>
											<strong css={{ color: colors.text }}>
												{sample.packageName ?? sample.packageId}
											</strong>
											<span
												css={{
													color: colors.textMuted,
													fontFamily: typography.fontFamilyMono,
													fontSize: typography.fontSize.sm,
													overflowWrap: 'anywhere',
												}}
											>
												{sample.path ?? '/'}
											</span>
											<span css={[recordStampCss, { marginLeft: 'auto' }]}>
												{formatTimestamp(sample.occurredAt)}
											</span>
										</span>
										<span
											css={{
												display: 'flex',
												flexWrap: 'wrap',
												gap: spacing.md,
												fontSize: typography.fontSize.sm,
												color: colors.textMuted,
												fontVariantNumeric: 'tabular-nums',
											}}
										>
											<span>Wall {formatSampleMs(sample.wallMs)}</span>
											<span>CPU {formatSampleMs(sample.cpuMs)}</span>
											{sample.status != null ? (
												<span>Status {sample.status}</span>
											) : null}
											<span
												css={{
													fontFamily: typography.fontFamilyMono,
													overflowWrap: 'anywhere',
												}}
											>
												Request {sample.requestId}
											</span>
										</span>
									</li>
								))}
							</ul>
						)}
					</div>
				</div>
			)}
		</AccountManagementPanel>
	)
}
