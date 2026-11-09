/** @jsxImportSource @emotion/react */
import { Tooltip } from '@base-ui/react/tooltip'
import { type ReactElement, type ReactNode } from 'react'
import { colors } from '#universal/styles/tokens.ts'
import { overlayPopupCss, overlayPositionerCss } from './overlay-styles.ts'

export function ControlTooltip({
	trigger,
	children,
}: {
	trigger: ReactElement
	children: ReactNode
}) {
	return (
		<Tooltip.Root>
			<Tooltip.Trigger render={trigger} delay={350} />
			<Tooltip.Portal>
				<Tooltip.Positioner
					side="bottom"
					sideOffset={6}
					css={overlayPositionerCss}
				>
					<Tooltip.Popup
						css={{
							...overlayPopupCss,
							padding: '4px 8px',
							fontSize: 12,
							color: colors.text,
						}}
					>
						{children}
					</Tooltip.Popup>
				</Tooltip.Positioner>
			</Tooltip.Portal>
		</Tooltip.Root>
	)
}
