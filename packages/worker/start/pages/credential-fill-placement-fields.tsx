/** @jsxImportSource @emotion/react */
import { css } from '@emotion/react'
import {
	type FillPlacementDraft,
	fillPlacementPartIds,
	type FillPlacementPartId,
} from '#universal/credential-fill-placement.ts'
import {
	fieldCss,
	fieldLabelCss,
	inputCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

const partsLabel: Record<FillPlacementPartId, string> = {
	headers: 'Headers',
	query: 'Query',
	path: 'URL path',
	body: 'Body',
}

const listCss = css({
	margin: 0,
	padding: 0,
	listStyle: 'none',
	display: 'grid',
	gap: spacing.xs,
})

const rowCss = css({
	display: 'flex',
	alignItems: 'flex-start',
	gap: spacing.sm,
	color: colors.text,
	fontSize: typography.fontSize.sm,
})

const hintCss = css({
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
})

type CredentialFillPlacementFieldsProps = {
	draft: FillPlacementDraft
	onChange: (next: FillPlacementDraft) => void
	disabled?: boolean
	/** When true, hide the field legend (parent already labeled the section). */
	hideLegend?: boolean
}

function togglePart(
	draft: FillPlacementDraft,
	part: FillPlacementPartId,
	checked: boolean,
): FillPlacementDraft {
	return { ...draft, [part]: checked }
}

export function CredentialFillPlacementFields(
	props: CredentialFillPlacementFieldsProps,
) {
	const { draft, onChange, disabled } = props
	return (
		<div css={fieldCss}>
			{props.hideLegend ? null : (
				<span css={fieldLabelCss}>Fill placement</span>
			)}
			<p css={hintCss}>
				Where Kody may fill this credential&apos;s placeholders on an outbound
				request. New credentials default to headers only. Distinct from inject,
				which only steers a scoped <code>credential()</code> client. Enforcement
				is not on yet; this stores the allowed parts.
			</p>
			<ul css={listCss}>
				{fillPlacementPartIds.map((part) => (
					<li key={part}>
						<label css={rowCss}>
							<input
								type="checkbox"
								checked={draft[part]}
								disabled={disabled}
								onChange={(event) => {
									onChange(togglePart(draft, part, event.currentTarget.checked))
								}}
							/>
							<span>{partsLabel[part]}</span>
						</label>
					</li>
				))}
			</ul>
			{draft.headers ? (
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Named headers (optional)</span>
					<input
						type="text"
						value={draft.namedHeaders}
						disabled={disabled}
						placeholder="Authorization, X-Api-Key"
						onInput={(event) => {
							onChange({
								...draft,
								namedHeaders: event.currentTarget.value,
							})
						}}
						css={inputCss}
					/>
					<p css={hintCss}>
						Leave empty to allow any header name. Comma-separated list limits
						fill to those names.
					</p>
				</label>
			) : null}
		</div>
	)
}
