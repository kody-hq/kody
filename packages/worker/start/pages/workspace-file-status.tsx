/** @jsxImportSource @emotion/react */
import { Button } from '../components/button.tsx'
import { colors } from '#universal/styles/tokens.ts'

export function WorkspaceFileStatus({
	message,
	action,
}: {
	message: string
	action?: { label: string; href: string } | { label: string; run: () => void }
}) {
	const control = {
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
					<Button variant="secondary" size="md" reloadDocument css={control} href={action.href}>
						{action.label}
					</Button>
				) : (
					<Button type="button" variant="secondary" size="md" css={control} onClick={action.run}>
						{action.label}
					</Button>
				))}
		</div>
	)
}
