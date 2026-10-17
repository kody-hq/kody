/** @jsxImportSource @emotion/react */
import { useState, type ComponentProps } from 'react'
import { colors, spacing } from '#universal/styles/tokens.ts'

type PasswordRevealInputProps = Omit<ComponentProps<'input'>, 'type'> & {
	revealNoun?: string
	revealed?: boolean
	onRevealedChange?: (revealed: boolean) => void
}

export function PasswordRevealInput({
	revealNoun = 'password',
	revealed: controlled,
	onRevealedChange,
	...props
}: PasswordRevealInputProps) {
	const [internal, setInternal] = useState(false)
	const revealed = controlled ?? internal
	const label = `${revealed ? 'Hide' : 'Show'} ${revealNoun}`
	return (
		<div
			css={{
				position: 'relative',
				display: 'flex',
				alignItems: 'center',
				width: '100%',
				minWidth: 0,
			}}
		>
			<input
				{...props}
				type={revealed ? 'text' : 'password'}
				autoCorrect="off"
				spellCheck={false}
				autoCapitalize="off"
				css={{ paddingRight: '4.5rem' }}
			/>
			<button
				type="button"
				aria-label={label}
				aria-pressed={revealed}
				title={label}
				css={{
					position: 'absolute',
					right: spacing.sm,
					top: '50%',
					transform: 'translateY(-50%)',
					background: 'none',
					border: 'none',
					borderRadius: '999px',
					padding: spacing.xs,
					width: '3.5rem',
					height: '2rem',
					color: colors.text,
					cursor: 'pointer',
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					fontSize: '0.75rem',
					fontWeight: 600,
					'&:hover': { background: colors.primarySoft },
				}}
				onClick={() => {
					onRevealedChange?.(!revealed)
					if (controlled === undefined) setInternal(!revealed)
				}}
			>
				{revealed ? 'Hide' : 'Show'}
			</button>
		</div>
	)
}
