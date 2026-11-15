/** @jsxImportSource @emotion/react */
import { fieldCss, fieldLabelCss } from '#universal/styles/style-primitives.ts'
import {
	defaultFeatureFlagAudience,
	type FeatureFlagAudience,
} from '#universal/feature-flags/audiences.ts'
import { Select } from './input.tsx'
export function renderAdminFeatureFlagAudienceField(input: {
	audience: FeatureFlagAudience | undefined
	disabled: boolean
}) {
	const audience = input.audience ?? defaultFeatureFlagAudience
	return (
		<label css={fieldCss}>
			<span css={fieldLabelCss}>Audience</span>
			<Select name="audience" disabled={input.disabled} defaultValue={audience}>
				<option value="everyone">Everyone</option>
				<option value="experiments_opt_in">Experiments opt-in</option>
			</Select>
		</label>
	)
}
