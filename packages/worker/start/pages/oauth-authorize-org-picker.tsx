/** @jsxImportSource @emotion/react */
import {
	oauthAuthorizeOrgField,
	type OAuthAuthorizeConsentOrg,
} from '#client/routes/oauth-authorize-form.ts'
import {
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	inputCss,
	getAlertCardCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

export function AuthorizeOrgField(props: {
	orgs: readonly OAuthAuthorizeConsentOrg[]
	selectedOrgSlug: string | null
	signedIn: boolean
	onChange: (slug: string | null) => void
	requiredOrgSlug?: string | null
	requiredReason?: string | null
}) {
	const field = oauthAuthorizeOrgField(props)
	if (field.kind === 'hidden')
		return (
			<input
				type="hidden"
				name="org"
				value={field.slug}
				data-testid="oauth-authorize-org"
			/>
		)
	if (field.kind === 'locked') {
		const selected = field.options.find((org) => org.slug === field.slug)
		const label = selected?.displayName
			? `${selected.displayName} (@${field.slug})`
			: `@${field.slug}`
		return (
			<div
				css={{ display: 'grid', gap: spacing.sm }}
				data-testid="oauth-authorize-org-locked"
			>
				<input
					type="hidden"
					name="org"
					value={field.slug}
					data-testid="oauth-authorize-org"
				/>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Organization</span>
					<select
						css={inputCss}
						value={field.slug}
						disabled
						aria-disabled="true"
						data-testid="oauth-authorize-org-disabled"
					>
						<option value={field.slug}>{label}</option>
					</select>
				</label>
				<p
					css={{
						...descriptionCss,
						margin: 0,
						color: colors.textMuted,
					}}
					data-testid="oauth-authorize-org-locked-reason"
				>
					{field.reason}
				</p>
			</div>
		)
	}
	if (field.kind === 'missing')
		return (
			<p
				role="alert"
				data-testid="oauth-authorize-org-missing"
				css={getAlertCardCss('error')}
			>
				This account has no organization to bind this connection to.
			</p>
		)
	if (field.kind === 'pending') return null
	return (
		<div css={fieldCss} data-testid="oauth-authorize-org-picker">
			<label css={labelBlockCss}>
				<span css={fieldLabelCss}>Organization</span>
				<select
					name="org"
					required
					data-testid="oauth-authorize-org"
					css={inputCss}
					value={field.selectedSlug ?? ''}
					onChange={(event) =>
						props.onChange(event.currentTarget.value.trim() || null)
					}
				>
					{field.selectedSlug ? null : (
						<option value="" disabled>
							Choose an organization
						</option>
					)}
					{field.options.map((org) => (
						<option key={org.slug} value={org.slug}>
							{org.displayName
								? `${org.displayName} (@${org.slug})`
								: `@${org.slug}`}
						</option>
					))}
				</select>
			</label>
			<p css={hintCss}>
				The agent runs as this workspace. Local compute is separate from which
				workspace it acts in.
			</p>
		</div>
	)
}

const labelBlockCss = {
	display: 'grid',
	gap: spacing.xs,
}

const hintCss = {
	margin: 0,
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
}
