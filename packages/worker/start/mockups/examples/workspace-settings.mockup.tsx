/** @jsxImportSource @emotion/react */
import { Badge } from '../../components/badge.tsx'
import { Button } from '../../components/button.tsx'
import { Switch } from '../../components/choice-controls.tsx'
import {
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
} from '../../pages/account-management-components.tsx'
import { colors, spacing } from '#universal/styles/tokens.ts'
import type { Mockup } from '../mockup.ts'

function SettingRow(props: { label: string; hint: string; on: boolean }) {
	return (
		<label
			css={{
				display: 'flex',
				justifyContent: 'space-between',
				alignItems: 'center',
				gap: spacing.md,
				padding: `${spacing.sm} 0`,
				borderTop: `1px solid ${colors.borderSubtle}`,
			}}
		>
			<span css={{ display: 'grid', gap: 2 }}>
				<span css={{ fontWeight: 600 }}>{props.label}</span>
				<span css={{ color: colors.textMuted, fontSize: '0.9rem' }}>
					{props.hint}
				</span>
			</span>
			<Switch checked={props.on} onCheckedChange={() => {}} />
		</label>
	)
}

/** Example: a settings page in the real workspace shell (signed in as the local seed user). */
export default {
	title: 'Workspace settings card (example)',
	description: 'Real rail, page header, and panel with proposed rows',
	shell: 'workspace',
	rail: 'apps',
	states: {
		default: () => (
			<AccountManagementShell layout="detail" currentHref="/dev-mockups">
				<AccountPageHeader
					title="App permissions"
					description="Choose what package apps may do when someone opens them."
					currentHref="/dev-mockups"
				/>
				<AccountManagementPanel
					title="Running apps"
					description="Apps run on the visitor's account only after they agree."
				>
					<SettingRow
						label="Ask before an app runs as me"
						hint="Shows a one-time confirmation per app."
						on
					/>
					<SettingRow
						label="Allow apps from my organizations"
						hint="Skip the confirmation for apps my orgs publish."
						on={false}
					/>
					<div
						css={{
							display: 'flex',
							gap: spacing.sm,
							alignItems: 'center',
							paddingTop: spacing.sm,
						}}
					>
						<Badge>3 apps allowed</Badge>
						<Button type="button" variant="secondary" size="sm">
							Review allowed apps
						</Button>
					</div>
				</AccountManagementPanel>
			</AccountManagementShell>
		),
	},
} satisfies Mockup
