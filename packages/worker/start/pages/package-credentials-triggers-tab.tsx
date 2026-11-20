/** @jsxImportSource @emotion/react */
import { Table } from '../components/table.tsx'
import { Switch } from '../components/choice-controls.tsx'
import { Button } from '../components/button.tsx'
import { AutomationExecutionSettings } from '../components/automation-execution-settings.tsx'
import type { ReactNode } from 'react'
import { TextLink } from '../components/text-link.tsx'
import {
	canEditTrigger,
	triggerMappingRows,
} from '#client/routes/package-credentials-editing.ts'
import {
	AccountManagementPanel,
	accountDisclosureCss,
} from './account-management-components.tsx'
import {
	type CredentialMappingTarget,
	type PackageTriggerInstanceView,
	type PackageTriggerView,
	buildCredentialApprovalHref,
} from '#universal/credential-contracts.ts'
import {
	canToggleTriggerEnablement,
	describeTrigger,
	triggerEnablementStateLabel,
	triggerStateLabel,
	withheldTriggerMappingsNote,
} from '#universal/package-credentials-page.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	type PackageTabContext,
	mutedCss,
	renderEffective,
	renderIncomplete,
	renderMappingCell,
	renderStatus,
	rowCss,
	tabLedeCss,
} from './package-credentials-tabs.tsx'

function renderTriggerMappings(
	context: PackageTabContext,
	trigger: PackageTriggerView,
	instance: PackageTriggerInstanceView | null,
	options: { createInstance?: boolean } = {},
) {
	const withheld = withheldTriggerMappingsNote(trigger)
	if (withheld) return <p css={mutedCss}>{withheld}</p>
	if (trigger.trigger.kind === 'webhook' && trigger.instanceId === null) {
		return (
			<p css={mutedCss}>
				{context.view.package.canManage
					? 'This webhook has no URL yet. Once someone mints it from Settings, its runs use their default mappings.'
					: 'This webhook has no URL yet. Once someone who manages this package mints it, its runs use their default mappings.'}
			</p>
		)
	}
	const editable =
		Boolean(context.renderMappingCell) &&
		(options.createInstance
			? canEditTrigger(trigger)
			: instance
				? instance.canEdit
				: canEditTrigger(trigger))
	// A brand-new instance has no overrides yet, do not show the primary
	// instance's stored picks as if they already applied.
	const mappingSource = options.createInstance
		? []
		: (instance?.mappings ?? trigger.mappings)
	const rows = editable
		? triggerMappingRows(context.view, {
				...trigger,
				mappings: mappingSource,
			})
		: mappingSource.flatMap((mapping) => {
				const need = context.view.needs.find(
					(candidate) => candidate.key === mapping.needKey,
				)
				return need ? [{ need, mapping }] : []
			})
	if (rows.length === 0) {
		return (
			<p css={mutedCss}>
				Runs of this trigger use the package’s default mappings.
			</p>
		)
	}
	const mappingTarget: CredentialMappingTarget = {
		type: 'trigger',
		trigger: trigger.trigger,
		...(instance ? { enablementId: instance.enablement.id } : {}),
		...(options.createInstance ? { createInstance: true } : {}),
	}
	return (
		<div css={{ display: 'grid', gap: spacing.sm }}>
			{editable &&
			trigger.canEdit &&
			(options.createInstance || (!instance && trigger.enablement === null)) ? (
				<p
					data-testid="package-trigger-will-enable"
					css={{ margin: 0, color: colors.warningText }}
				>
					{options.createInstance
						? 'Saving a credential choice here turns on another instance for you.'
						: 'This trigger is off. Saving a credential choice here turns it on for you.'}
				</p>
			) : null}
			<div css={{ overflowX: 'auto' }}>
				<Table>
					<thead>
						<tr>
							<th scope="col">Need</th>
							<th scope="col">This trigger</th>
							<th scope="col">Runs use</th>
							<th scope="col">Status</th>
						</tr>
					</thead>
					<tbody>
						{rows.map(({ need, mapping }) => (
							<tr key={need.key}>
								<td>
									<strong>{need.key}</strong>
								</td>
								<td>
									{renderMappingCell(context, {
										target: mappingTarget,
										need,
										stored: mapping?.override ?? null,
										inheritLabel: 'Inherits your default',
										editable: editable && need.supplier !== 'publisher',
										trigger,
									})}
								</td>
								<td>
									{mapping ? (
										renderEffective(context.orgSlug, mapping.effective)
									) : (
										<span css={mutedCss}>Your default, once on</span>
									)}
								</td>
								<td>{mapping ? renderStatus(mapping.effective) : null}</td>
							</tr>
						))}
					</tbody>
				</Table>
			</div>
		</div>
	)
}

function renderEnablementSwitch(input: {
	context: PackageTabContext
	trigger: PackageTriggerView
	checked: boolean
	enablementId?: string
	label: string
	disabled?: boolean
}) {
	const setEnablement = input.context.setTriggerEnablement
	if (!setEnablement || input.disabled) {
		return <span css={mutedCss}>{input.label}</span>
	}
	const busyKey =
		input.enablementId ??
		`${input.trigger.trigger.kind}:${input.trigger.trigger.name}`
	const busy = input.context.enablementBusyKey === busyKey
	return (
		<Switch
			checked={input.checked}
			aria-label={`${input.label}: ${describeTrigger(input.trigger.trigger)}`}
			data-testid={`package-trigger-switch-${input.trigger.trigger.kind}-${input.trigger.trigger.name}${input.enablementId ? `-${input.enablementId}` : ''}`}
			disabled={busy || Boolean(input.context.enablementBusyKey)}
			onCheckedChange={(checked) => {
				setEnablement({
					trigger: input.trigger.trigger,
					state: checked ? 'on' : 'off',
					...(input.enablementId ? { enablementId: input.enablementId } : {}),
				})
			}}
		/>
	)
}

function renderInstanceCard(
	context: PackageTabContext,
	trigger: PackageTriggerView,
	instance: PackageTriggerInstanceView,
	index: number,
	total: number,
) {
	const stateLabel = triggerEnablementStateLabel(instance.enablement)
	const canToggle =
		Boolean(context.setTriggerEnablement) &&
		canToggleTriggerEnablement(trigger) &&
		instance.canEdit &&
		instance.enablement.enabledByYou
	return (
		<div
			key={instance.enablement.id}
			data-testid={`package-trigger-instance-${instance.enablement.id}`}
			css={{
				display: 'grid',
				gap: spacing.sm,
				paddingTop: index === 0 ? 0 : spacing.sm,
				borderTop: index === 0 ? 'none' : `1px solid ${colors.borderSubtle}`,
			}}
		>
			<div
				css={{
					...rowCss,
					justifyContent: 'space-between',
					alignItems: 'center',
				}}
			>
				<div css={{ display: 'grid', gap: spacing.xs, minWidth: 0 }}>
					{total > 1 ? (
						<p
							css={{
								margin: 0,
								fontWeight: typography.fontWeight.semibold,
							}}
						>
							{instance.instanceLabel?.trim()
								? instance.instanceLabel.trim()
								: `Instance ${index + 1}`}
						</p>
					) : instance.instanceLabel?.trim() ? (
						<p
							css={{
								margin: 0,
								fontWeight: typography.fontWeight.semibold,
							}}
						>
							{instance.instanceLabel.trim()}
						</p>
					) : null}
					<span css={mutedCss}>{stateLabel}</span>
				</div>
				{canToggle ? (
					renderEnablementSwitch({
						context,
						trigger,
						checked: instance.enablement.state !== 'off',
						enablementId: instance.enablement.id,
						label: instance.enablement.state === 'off' ? 'Off' : 'On',
					})
				) : total > 1 ? (
					<span css={mutedCss}>{stateLabel}</span>
				) : null}
			</div>
			{renderTriggerMappings(context, trigger, instance)}
			<details css={accountDisclosureCss}>
				<summary>Details</summary>
				<p css={{ ...mutedCss, fontFamily: typography.fontFamilyMono }}>
					Enablement id: {instance.enablement.id}
				</p>
			</details>
		</div>
	)
}

export function renderTriggersTab(context: PackageTabContext): ReactNode {
	const { view } = context
	if (view.triggers.length === 0) {
		return (
			<AccountManagementPanel>
				<p css={mutedCss}>
					This package declares no schedules, subscriptions, or webhooks.
				</p>
			</AccountManagementPanel>
		)
	}
	return (
		<>
			{renderIncomplete(context, 'triggers')}
			<p css={tabLedeCss}>
				Each trigger runs as the person who turned it on. A trigger can map its
				own credentials; any need it leaves alone uses that person’s default
				mapping. You can turn on more than one instance of a schedule or
				subscription with different credentials.
			</p>
			{context.enablementError ? (
				<p
					role="alert"
					data-testid="package-trigger-enablement-error"
					css={{ margin: 0, color: colors.danger }}
				>
					{context.enablementError}
				</p>
			) : null}
			{view.triggers.map((trigger, index) => {
				const id = `package-trigger-${trigger.trigger.kind}-${trigger.trigger.name}`
				// Trigger names may hold spaces; aria-labelledby splits on them.
				const titleId = `package-trigger-title-${index}`
				const instances = trigger.instances
				const canToggle = canToggleTriggerEnablement(trigger)
				const webhookNeedsApprove =
					trigger.trigger.kind === 'webhook' &&
					trigger.instanceId !== null &&
					trigger.enablement === null &&
					trigger.canEdit
				const approveHref = webhookNeedsApprove
					? buildCredentialApprovalHref({
							username: context.username,
							kodyId: context.kodyId,
							changes: [],
							enable: [
								{
									...trigger.trigger,
									...(trigger.instanceId
										? { endpointId: trigger.instanceId }
										: {}),
								},
							],
						})
					: null
				return (
					<AccountManagementPanel
						key={id}
						headingId={titleId}
						testId={id}
						title={describeTrigger(trigger.trigger)}
						actions={
							instances.length === 0 ? (
								canToggle ? (
									renderEnablementSwitch({
										context,
										trigger,
										checked: false,
										label: 'Off',
									})
								) : approveHref ? (
									<TextLink href={approveHref}>Approve to turn on</TextLink>
								) : (
									<span css={mutedCss}>{triggerStateLabel(trigger)}</span>
								)
							) : instances.length > 1 ? (
								<span css={mutedCss}>{instances.length} instances</span>
							) : null
						}
					>
						{instances.length === 0
							? renderTriggerMappings(context, trigger, null)
							: instances.map((instance, instanceIndex) =>
									renderInstanceCard(
										context,
										trigger,
										instance,
										instanceIndex,
										instances.length,
									),
								)}
						{trigger.canAddInstance && instances.length > 0 ? (
							<details
								css={{
									...accountDisclosureCss,
									paddingTop: spacing.sm,
									borderTop: `1px solid ${colors.borderSubtle}`,
								}}
								data-testid={`package-trigger-add-instance-${trigger.trigger.kind}-${trigger.trigger.name}`}
							>
								<summary>Add another instance</summary>
								<div css={{ display: 'grid', gap: spacing.sm }}>
									{trigger.trigger.kind === 'webhook' ? (
										<TextLink
											href={`/@${context.username}/${context.kodyId}/settings#webhooks`}
										>
											Mint another labeled URL in Settings
										</TextLink>
									) : (
										<>
											<p css={mutedCss}>
												Adds another live copy that uses your default
												credentials. Then change that instance’s credential
												mapping on its card (saving one need at a time never
												mints a second copy).
											</p>
											<Button
												type="button"
												disabled={Boolean(context.enablementBusyKey)}
												variant="secondary"
												onClick={() => {
													context.setTriggerEnablement?.({
														trigger: trigger.trigger,
														state: 'on',
														createInstance: true,
													})
												}}
											>
												Add another instance
											</Button>
										</>
									)}
								</div>
							</details>
						) : null}
						{trigger.canEdit &&
						(trigger.trigger.kind === 'subscription' ||
							trigger.trigger.kind === 'webhook') ? (
							<AutomationExecutionSettings
								orgSlug={context.orgSlug}
								target={{
									kind: trigger.trigger.kind,
									packageId: context.kodyId,
									name: trigger.trigger.name,
								}}
							/>
						) : null}
					</AccountManagementPanel>
				)
			})}
		</>
	)
}
