/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { chartColor, formatIntegerNumber } from '#client/charts/chart-theme.ts'
import { accountDisclosureCss } from './account-management-components.tsx'
import { formatEstimatedCreditMicroUsd } from '#universal/credits.ts'
import { type AccountCreditsDebitMeter } from '#universal/loader-data.ts'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { includeBarPercent } from '#universal/usage-presentation.ts'

/** Collapsed rate card for Worker compute + Rows read in the usage page's Credits section. */
export function renderCreditsDebitRateCard(
	meters: Array<AccountCreditsDebitMeter>,
	options: { pastIncludeNeedsAttention: boolean },
) {
	if (meters.length === 0) return null
	return (
		<details
			data-credits-rate-card
			css={{
				...accountDisclosureCss,
				borderTop: `1px solid ${colors.border}`,
				paddingTop: 'clamp(2rem, 4vw, 2.75rem)',
				minWidth: 0,
				maxWidth: '100%',
			}}
		>
			<summary>How credits are charged</summary>
			<p
				data-credits-rate-card-path
				css={{
					margin: `0 0 ${spacing.sm}`,
					fontSize: typography.fontSize.sm,
					color: colors.textMuted,
					textWrap: 'pretty' as const,
					overflowWrap: 'anywhere' as const,
					maxWidth: '100%',
				}}
			>
				Usage within the monthly include is free. Past it, credits pay these
				rates until they run out; then usage past the include stops.
			</p>
			{/* Narrow viewports: one stacked card per meter (no page blow-out). */}
			<ul
				data-credits-rate-card-stack
				aria-label="Credit debit rates and usage this period"
				css={debitRateStackCss}
			>
				{meters.map((meter) => {
					const barPercent = includeBarPercent(meter.percentOfInclude)
					const attention =
						options.pastIncludeNeedsAttention && meter.pastInclude > 0
					return (
						<li
							key={meter.meter}
							data-credits-debit-meter={meter.meter}
							css={debitRateStackItemCss}
						>
							<div css={debitRateMeterCellCss}>
								<span>{meter.label}</span>
								{renderIncludeBar({ barPercent, attention })}
							</div>
							<p css={debitRateStackRateCss}>{meter.unitRateLabel}</p>
							<dl css={debitRateStackFactsCss}>
								{stackFacts(meter).map((fact) => (
									<div key={fact.label} css={debitRateStackFactCss}>
										<dt css={debitRateStackFactLabelCss}>{fact.label}</dt>
										<dd css={debitRateStackFactValueCss}>{fact.value}</dd>
									</div>
								))}
							</dl>
						</li>
					)
				})}
			</ul>
			{/* Wider viewports: readable multi-column table. */}
			<div css={debitRateTableScrollCss}>
				<table
					aria-label="Credit debit rates and usage this period"
					css={debitRateTableCss}
				>
					<thead>
						<tr>
							<th scope="col">Meter</th>
							<th scope="col">Unit rate</th>
							<th scope="col" css={debitRateNumericCss}>
								Monthly include
							</th>
							<th scope="col" css={debitRateNumericCss}>
								Used this period
							</th>
							<th scope="col" css={debitRateNumericCss}>
								Past include
							</th>
							<th scope="col" css={debitRateNumericCss}>
								Est. credits this period
							</th>
						</tr>
					</thead>
					<tbody>
						{meters.map((meter) => {
							const barPercent = includeBarPercent(meter.percentOfInclude)
							const attention =
								options.pastIncludeNeedsAttention && meter.pastInclude > 0
							return (
								<tr key={meter.meter} data-credits-debit-meter={meter.meter}>
									<th scope="row">
										<div css={debitRateMeterCellCss}>
											<span>{meter.label}</span>
											{renderIncludeBar({ barPercent, attention })}
										</div>
									</th>
									<td>{meter.unitRateLabel}</td>
									<td css={debitRateNumericCss}>
										{formatIntegerNumber(meter.include)}
									</td>
									<td css={debitRateNumericCss}>
										{formatIntegerNumber(meter.used)}
									</td>
									<td css={debitRateNumericCss}>
										{formatIntegerNumber(meter.pastInclude)}
									</td>
									<td css={debitRateNumericCss}>
										{formatEstimatedCreditMicroUsd(meter.estCreditsMicroUsd)}
									</td>
								</tr>
							)
						})}
					</tbody>
				</table>
			</div>
		</details>
	)
}

function stackFacts(meter: AccountCreditsDebitMeter) {
	return [
		{ label: 'Monthly include', value: formatIntegerNumber(meter.include) },
		{ label: 'Used this period', value: formatIntegerNumber(meter.used) },
		{ label: 'Past include', value: formatIntegerNumber(meter.pastInclude) },
		{
			label: 'Est. credits this period',
			value: formatEstimatedCreditMicroUsd(meter.estCreditsMicroUsd),
		},
	]
}

function renderIncludeBar(input: { barPercent: number; attention: boolean }) {
	return (
		<div aria-hidden="true" css={debitRateBarTrackCss}>
			<div
				css={{
					...debitRateBarFillCss,
					width: `${input.barPercent}%`,
					background: input.attention ? chartColor.amber : chartColor.blue,
				}}
			/>
		</div>
	)
}

const debitRateStackCss: CSSObject = {
	display: 'none',
	margin: 0,
	padding: 0,
	listStyle: 'none' as const,
	gap: spacing.md,
	minWidth: 0,
	maxWidth: '100%',
	[mq.mobile]: {
		display: 'grid',
	},
}

const debitRateStackItemCss: CSSObject = {
	display: 'grid',
	gap: spacing.sm,
	minWidth: 0,
	paddingBottom: spacing.md,
	borderBottom: `1px solid ${colors.border}`,
	'&:last-child': {
		paddingBottom: 0,
		borderBottom: 'none',
	},
}

const debitRateStackRateCss: CSSObject = {
	margin: 0,
	fontSize: typography.fontSize.sm,
	color: colors.text,
	overflowWrap: 'anywhere' as const,
}

const debitRateStackFactsCss: CSSObject = {
	margin: 0,
	display: 'grid',
	gap: spacing.xs,
	minWidth: 0,
}

const debitRateStackFactCss: CSSObject = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr) auto',
	gap: spacing.sm,
	alignItems: 'baseline' as const,
	minWidth: 0,
}

const debitRateStackFactLabelCss: CSSObject = {
	margin: 0,
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
	minWidth: 0,
}

const debitRateStackFactValueCss: CSSObject = {
	margin: 0,
	fontSize: typography.fontSize.sm,
	fontVariantNumeric: 'tabular-nums' as const,
	color: colors.text,
	textAlign: 'end' as const,
	whiteSpace: 'nowrap' as const,
}

const debitRateTableScrollCss: CSSObject = {
	display: 'block',
	minWidth: 0,
	maxWidth: '100%',
	overflowX: 'auto' as const,
	[mq.mobile]: {
		display: 'none',
	},
}

const debitRateTableCss: CSSObject = {
	width: '100%',
	borderCollapse: 'collapse' as const,
	fontSize: typography.fontSize.sm,
	color: colors.text,
	'& th, & td': {
		padding: `${spacing.xs} ${spacing.sm}`,
		borderBottom: `1px solid ${colors.border}`,
		textAlign: 'start' as const,
		verticalAlign: 'middle' as const,
	},
	'& thead th': {
		color: colors.textMuted,
		fontWeight: typography.fontWeight.semibold,
		whiteSpace: 'nowrap' as const,
	},
}

const debitRateNumericCss: CSSObject = {
	textAlign: 'end' as const,
	fontVariantNumeric: 'tabular-nums' as const,
	whiteSpace: 'nowrap' as const,
}

const debitRateMeterCellCss: CSSObject = {
	display: 'grid',
	gap: '0.35rem',
	minWidth: 0,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
}

const debitRateBarTrackCss: CSSObject = {
	height: '8px',
	borderRadius: radius.md,
	background: colors.border,
	overflow: 'hidden',
	width: '100%',
	maxWidth: '10rem',
	[mq.mobile]: {
		maxWidth: 'none',
	},
}

const debitRateBarFillCss: CSSObject = {
	height: '100%',
}
