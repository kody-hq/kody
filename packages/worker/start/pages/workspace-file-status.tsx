/** @jsxImportSource @emotion/react */
import { colors } from '#universal/styles/tokens.ts'
import { getSecondaryButtonCss } from '#universal/styles/style-primitives.ts'

export function WorkspaceFileStatus({
	message,
	action,
}: {
	message: string
	action?: { label: string; href: string } | { label: string; run: () => void }
}) {
	const control = {
		...getSecondaryButtonCss(),
		fontSize: 12,
		minHeight: 28,
		padding: '4px 10px',
	}
	return (
		<div
			css={{
				display: 'grid',
				justifyItems: 'center',
				gap: 12,
				padding: '28px 16px',
				textAlign: 'center',
			}}
		>
			<p
				role="status"
				css={{ margin: 0, color: colors.textMuted, fontSize: 13 }}
			>
				{message}
			</p>
			{action &&
				('href' in action ? (
					<a css={control} href={action.href}>
						{action.label}
					</a>
				) : (
					<button type="button" css={control} onClick={action.run}>
						{action.label}
					</button>
				))}
		</div>
	)
}
