/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

export function AccountConnectedAppDisconnectOptions(props: {
	credentials: Array<{ id: string; name: string }>
	selectedIds: ReadonlySet<string>
	onChange: (ids: ReadonlySet<string>) => void
}) {
	if (props.credentials.length === 0) return null
	return (
		<div css={disconnectOptionsCss}>
			{props.credentials.map((credential) => (
				<label key={credential.id} css={disconnectOptionCss}>
					<input
						type="checkbox"
						checked={props.selectedIds.has(credential.id)}
						onChange={(event) => {
							const next = new Set(props.selectedIds)
							if (event.currentTarget.checked) next.add(credential.id)
							else next.delete(credential.id)
							props.onChange(next)
						}}
					/>
					<span>Also disconnect {credential.name}</span>
				</label>
			))}
		</div>
	)
}

const disconnectOptionsCss: CSSObject = {
	display: 'grid',
	gap: spacing.xs,
}

const disconnectOptionCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.xs,
	color: colors.text,
	fontSize: typography.fontSize.sm,
	whiteSpace: 'nowrap',
	'& input': { accentColor: colors.primary },
}
