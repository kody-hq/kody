/** @jsxImportSource @emotion/react */
import {
	oauthAuthorizeOrgField,
	type OAuthAuthorizeConsentOrg,
} from '#client/routes/oauth-authorize-form.ts'
import {
	fieldCss,
	fieldLabelCss,
	inputCss,
	getAlertCardCss,
} from '#universal/styles/style-primitives.ts'

export function AuthorizeOrgField(props: {
	orgs: readonly OAuthAuthorizeConsentOrg[]
	selectedOrgSlug: string | null
	signedIn: boolean
	onChange: (slug: string | null) => void
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
		<label css={fieldCss} data-testid="oauth-authorize-org-picker">
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
	)
}
