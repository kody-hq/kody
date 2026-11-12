/** @jsxImportSource @emotion/react */
import { colors } from '#universal/styles/tokens.ts'

export function WorkspaceEmptyFolder() {
	return (
		<div
			css={{
				display: 'grid',
				justifyItems: 'center',
				gap: 10,
				padding: '36px 16px',
				textAlign: 'center',
				color: colors.textMuted,
				fontSize: 13,
			}}
		>
			<svg
				aria-hidden="true"
				width="28"
				height="28"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinejoin="round"
			>
				<path d="M3 6h7l2 2h9v11H3z" />
			</svg>
			<p css={{ margin: 0 }}>This folder is empty</p>
		</div>
	)
}
