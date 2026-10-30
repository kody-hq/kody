/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { spacing } from '#universal/styles/tokens.ts'
import {
	accountFieldLabelCss,
	accountFieldNoteCss,
} from '../pages/account-management-components.tsx'

export type OrgProfileVisibilityChoice = 'public' | 'private'

const options = [
	{
		value: 'public',
		label: 'Public',
		note: 'Anyone can open the page and see its name, photo, bio, and public packages.',
	},
	{
		value: 'private',
		label: 'Private',
		note: 'Only members can open the page. Everyone else gets a not-found page.',
	},
] as const

/**
 * Public/Private choice for a team org's page at `/@slug`, shared by the
 * create form and org settings (same radios as account profile visibility).
 */
export function OrgVisibilityFieldset(props: {
	value: OrgProfileVisibilityChoice
	onChange: (value: OrgProfileVisibilityChoice) => void
	handle: string
	disabled?: boolean
	testId?: string
}) {
	const baseId = props.testId ?? 'org-visibility'
	return (
		<fieldset css={fieldsetCss} data-testid={props.testId}>
			<legend css={accountFieldLabelCss}>Page visibility</legend>
			{options.map((option) => {
				// The note describes the radio instead of labelling it, so its
				// copy ("name, photo") does not match label lookups like "Name".
				const noteId = `${baseId}-${option.value}-note`
				return (
					<div key={option.value} css={optionCss}>
						<input
							id={`${baseId}-${option.value}`}
							type="radio"
							name="profileVisibility"
							value={option.value}
							checked={props.value === option.value}
							disabled={props.disabled}
							aria-describedby={noteId}
							onChange={() => props.onChange(option.value)}
						/>
						<span css={optionTextCss}>
							<label htmlFor={`${baseId}-${option.value}`}>
								{option.label}
							</label>
							{/* Clicking the note picks the option like its label does; the radio stays the accessible control. */}
							<span
								id={noteId}
								css={[accountFieldNoteCss, { cursor: 'pointer' }]}
								onClick={() => {
									if (!props.disabled) props.onChange(option.value)
								}}
							>
								{option.note}
							</span>
						</span>
					</div>
				)
			})}
			<p css={accountFieldNoteCss}>
				This controls kody.codes/@{props.handle || 'your-handle'}. Members are
				never listed, and private packages never show there.
			</p>
		</fieldset>
	)
}

const fieldsetCss = {
	margin: 0,
	padding: 0,
	border: 'none',
	display: 'grid',
	gap: spacing.sm,
} satisfies CSSObject

const optionCss = {
	display: 'flex',
	gap: spacing.sm,
	alignItems: 'flex-start',
	'& input': { marginTop: '0.3rem' },
} satisfies CSSObject

const optionTextCss = {
	display: 'grid',
	gap: spacing.xs,
} satisfies CSSObject
