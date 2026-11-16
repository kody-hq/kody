/** @jsxImportSource @emotion/react */
import { Field } from './field.tsx'
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
		<Field label="Audience">
			<Select name="audience" disabled={input.disabled} defaultValue={audience}>
				<option value="everyone">Everyone</option>
				<option value="experiments_opt_in">Experiments opt-in</option>
			</Select>
		</Field>
	)
}
