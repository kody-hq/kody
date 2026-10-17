/** @jsxImportSource @emotion/react */
import { CopyTextButton } from './copy-text-button.tsx'
import {
	ERROR_AGENT_PROMPT_IDLE_LABEL,
	ERROR_AGENT_PROMPT_TEST_ID,
} from '#universal/error-agent-prompt.ts'
import { spacing } from '#universal/styles/tokens.ts'

type ErrorAgentPromptButtonProps = {
	prompt: string
	/** Optional hint above the button. */
	hint?: string
	variant?: 'primary' | 'secondary' | 'pill' | 'ghost' | 'chip'
	size?: 'md' | 'sm'
	class?: string
}

const wrapCss = {
	display: 'grid',
	gap: spacing.sm,
	justifyItems: 'start' as const,
	marginTop: spacing.md,
}

const hintCss = {
	margin: 0,
	fontSize: '0.92rem',
	lineHeight: 1.45,
	maxWidth: '40rem',
}

/**
 * Hydrated “Copy prompt for your agent” control. Always stamps
 * `data-error-agent-prompt` so the inventory guard can find it.
 */
export function ErrorAgentPromptButton(props: ErrorAgentPromptButtonProps) {
	return (
		<div
			data-error-agent-prompt=""
			data-testid={ERROR_AGENT_PROMPT_TEST_ID}
			css={wrapCss}
		>
			{props.hint ? <p css={hintCss}>{props.hint}</p> : null}
			<CopyTextButton
				value={props.prompt}
				idleLabel={ERROR_AGENT_PROMPT_IDLE_LABEL}
				variant={props.variant ?? 'secondary'}
				size={props.size}
				class={props.class}
				ariaLabel={ERROR_AGENT_PROMPT_IDLE_LABEL}
			/>
		</div>
	)
}
