/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
import { CopyTextButton } from './copy-text-button.tsx'
import { buildWithAgentPrompt } from '#universal/build-with-agent.ts'

export function BuildWithAgentButton({
	business,
	label = 'Build with your agent',
	variant = 'ghost',
	onboardingPage,
	icons = true,
}: {
	business?: boolean
	label?: string
	variant?: 'ghost' | 'pill'
	/** False keeps the prompt agent-led, with no `/onboarding` link. */
	onboardingPage?: boolean
	/** False drops the agent marks beside the label. */
	icons?: boolean
}) {
	return (
		<CopyTextButton
			variant={variant}
			value={buildWithAgentPrompt({ business, onboardingPage })}
			ariaLabel={`${label}, copy setup prompt`}
			copiedLabel="Copied! Paste into your agent"
			idleLabel={
				icons ? (
					<span
						css={{
							display: 'inline-flex',
							alignItems: 'center',
							gap: '0.65rem',
						}}
					>
						<span
							aria-hidden="true"
							css={{ display: 'inline-flex', gap: '0.3rem' }}
						>
							{['claudecode', 'codex', 'cursor'].map((icon) => (
								<img
									key={icon}
									src={publicAsset(`/images/icons/${icon}.svg`)}
									alt=""
									width={18}
									height={18}
									css={{
										background: '#fff',
										borderRadius: '3px',
										padding: '2px',
									}}
								/>
							))}
						</span>
						{label}
					</span>
				) : (
					label
				)
			}
		/>
	)
}
