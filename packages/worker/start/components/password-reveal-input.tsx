/** @jsxImportSource @emotion/react */
import { Button } from './button.tsx'
import { useState, type ComponentProps } from 'react'
import { spacing } from '#universal/styles/tokens.ts'

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
			<Button
				variant="ghost"
				size="xs"
				type="button"
				aria-label={label}
				aria-pressed={revealed}
				title={label}
				css={{
					position: 'absolute',
					right: spacing.sm,
					insetBlock: 0,
					marginBlock: 'auto',
					height: 'fit-content',
					width: '3.5rem',
				}}
				onClick={() => {
					onRevealedChange?.(!revealed)
					if (controlled === undefined) setInternal(!revealed)
				}}
			>
				{revealed ? 'Hide' : 'Show'}
			</Button>
		</div>
	)
}
