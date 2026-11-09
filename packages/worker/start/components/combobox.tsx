/** @jsxImportSource @emotion/react */
import { Combobox as BaseCombobox } from '@base-ui/react/combobox'
import { Select } from '@base-ui/react/select'
import { useState } from 'react'
import { spacing } from '#universal/styles/tokens.ts'
import {
	fieldLabelCss,
	getSelectCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import { renderIcon } from './icon.tsx'
import {
	overlayItemCss,
	overlayPopupCss,
	overlayPositionerCss,
} from './overlay-styles.ts'

export type ComboboxOption = {
	id: string
	label: string
	keywords?: Array<string>
}
type ComboboxProps = {
	id: string
	label: string
	hideLabel?: boolean
	placeholder?: string
	minListWidth?: number
	selectOnly?: boolean
	compact?: boolean
	value: string
	options: Array<ComboboxOption>
	disabled?: boolean
	onChange: (value: string) => void
}

function matchesOption(option: ComboboxOption, query: string) {
	const normalized = query.toLocaleLowerCase()
	return [
		option.label,
		...option.label.split(/[^\p{L}\p{N}]+/u).slice(1),
		...(option.keywords ?? []),
	].some((value) => value.toLocaleLowerCase().startsWith(normalized))
}

export function Combobox(props: ComboboxProps) {
	const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(
		null,
	)
	const selected =
		props.options.find((option) => option.id === props.value) ?? null
	const popupCss = {
		...overlayPopupCss,
		width: `max(var(--anchor-width), ${props.minListWidth ?? 0}px)`,
	}
	const labelId = `${props.id}-label`
	return (
		<div
			ref={(element) => {
				if (element)
					setPortalContainer(
						element.closest<HTMLElement>('dialog, [popover], :fullscreen'),
					)
			}}
			css={{ display: 'grid', gap: spacing.xs, minWidth: 0 }}
		>
			<label
				id={labelId}
				htmlFor={props.id}
				css={props.hideLabel ? visuallyHiddenCss : fieldLabelCss}
			>
				{props.label}
			</label>
			{props.selectOnly ? (
				<Select.Root
					items={props.options.map(({ id, label }) => ({ value: id, label }))}
					value={selected?.id ?? null}
					onValueChange={(value) => {
						if (value !== null) props.onChange(value)
					}}
					disabled={props.disabled}
				>
					<Select.Trigger
						id={props.id}
						aria-labelledby={labelId}
						data-field-ring
						css={{ ...getSelectCss(), textAlign: 'left', userSelect: 'none' }}
					>
						<Select.Value placeholder={props.placeholder} />
					</Select.Trigger>
					<Select.Portal container={portalContainer ?? undefined}>
						<Select.Positioner
							alignItemWithTrigger={false}
							sideOffset={4}
							css={overlayPositionerCss}
						>
							<Select.Popup css={popupCss}>
								<Select.List>
									{props.options.map((option) => (
										<Select.Item
											key={option.id}
											value={option.id}
											css={overlayItemCss}
										>
											<span css={{ width: '1rem' }}>
												<Select.ItemIndicator>
													{renderIcon('check', { size: '1rem' })}
												</Select.ItemIndicator>
											</span>
											<Select.ItemText>{option.label}</Select.ItemText>
										</Select.Item>
									))}
								</Select.List>
							</Select.Popup>
						</Select.Positioner>
					</Select.Portal>
				</Select.Root>
			) : (
				<BaseCombobox.Root
					autoHighlight
					items={props.options}
					value={selected}
					onValueChange={(option) => {
						if (option) props.onChange(option.id)
					}}
					itemToStringLabel={(option) => option.label}
					itemToStringValue={(option) => option.id}
					isItemEqualToValue={(option, value) => option.id === value.id}
					filter={matchesOption}
					disabled={props.disabled}
				>
					<BaseCombobox.Input
						id={props.id}
						data-field-ring
						placeholder={props.placeholder}
						css={{ ...getSelectCss(), cursor: 'text' }}
					/>
					<BaseCombobox.Portal container={portalContainer ?? undefined}>
						<BaseCombobox.Positioner sideOffset={4} css={overlayPositionerCss}>
							<BaseCombobox.Popup css={popupCss}>
								<BaseCombobox.Empty css={{ padding: spacing.sm }}>
									No results
								</BaseCombobox.Empty>
								<BaseCombobox.List>
									{(option: ComboboxOption) => (
										<BaseCombobox.Item
											key={option.id}
											value={option}
											css={overlayItemCss}
										>
											<span css={{ width: '1rem' }}>
												<BaseCombobox.ItemIndicator>
													{renderIcon('check', { size: '1rem' })}
												</BaseCombobox.ItemIndicator>
											</span>
											{option.label}
										</BaseCombobox.Item>
									)}
								</BaseCombobox.List>
							</BaseCombobox.Popup>
						</BaseCombobox.Positioner>
					</BaseCombobox.Portal>
				</BaseCombobox.Root>
			)}
		</div>
	)
}
