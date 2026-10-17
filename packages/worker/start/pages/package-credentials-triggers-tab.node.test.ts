import { expect, test } from 'vitest'
import {
	type PackageCredentialsView,
	type PackageTriggerView,
} from '#universal/credential-contracts.ts'
import { renderStartPage } from '../test-support/render-start-page.ts'
import { renderTriggersTab } from './package-credentials-triggers-tab.tsx'

function trigger(
	kind: PackageTriggerView['trigger']['kind'],
	name: string,
): PackageTriggerView {
	const enablement = {
		id: 'instance-a',
		state: 'on' as const,
		enabledByYou: true,
	}
	return {
		trigger: { kind, name },
		instanceId: 'trigger-a',
		enablement,
		canEdit: true,
		mappings: [],
		instances: [{ enablement, canEdit: true, mappings: [] }],
		canAddInstance: kind === 'cron',
	}
}
async function render(triggers: Array<PackageTriggerView>) {
	const view: PackageCredentialsView = {
		ok: true,
		package: { id: 'package-a', kodyId: 'repo', canManage: true },
		needs: [],
		locked: [],
		incomplete: [],
		triggers,
	}
	return renderStartPage(
		renderTriggersTab({
			orgSlug: 'team',
			username: 'team',
			kodyId: 'repo',
			view,
			setTriggerEnablement() {},
		}),
	)
}

test('native trigger cards expose owned instance switches and additive instance controls', async () => {
	const html = await render([trigger('cron', 'daily')])
	expect(html).toContain('role="switch"')
	expect(html).toContain('aria-checked="true"')
	expect(html).toContain('package-trigger-instance-instance-a')
	expect(html).toContain('Add another instance')
})

test('email stays approval-only and other peoples instances have no switch', async () => {
	expect(
		await render([trigger('subscription', 'email.message.received')]),
	).not.toContain('role="switch"')
	const other = trigger('cron', 'daily')
	other.canEdit = false
	other.canAddInstance = false
	other.instances[0]!.canEdit = false
	other.instances[0]!.enablement.enabledByYou = false
	expect(await render([other])).not.toContain('role="switch"')
})
