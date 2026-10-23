import { expect, test } from 'vitest'
import {
	type CredentialApprovalChangeView,
	type CredentialApprovalEnableView,
	type CredentialApprovalView,
	type CredentialRef,
} from '#universal/credential-contracts.ts'
import {
	approvalChangeIsNoop,
	approvalProblems,
	groupApprovalChanges,
} from './package-credential-approval-page.ts'

const bot: CredentialRef = {
	id: 'cred-1',
	name: 'acme-bot',
	scope: 'org',
	kind: 'oauth',
}
const mine: CredentialRef = {
	id: 'cred-2',
	name: 'openai',
	scope: 'personal',
	kind: 'secret',
}

function change(
	overrides: Partial<CredentialApprovalChangeView>,
): CredentialApprovalChangeView {
	return {
		target: { type: 'default', layer: 'org' },
		needKey: 'github',
		need: null,
		before: null,
		beforeUnusableIds: [],
		after: [bot],
		willEnable: false,
		error: null,
		...overrides,
	}
}

const daily = { kind: 'cron', name: 'daily' } as const

function enableEntry(
	overrides: Partial<CredentialApprovalEnableView> = {},
): CredentialApprovalEnableView {
	return {
		trigger: { kind: 'webhook', name: 'incoming' },
		willEnable: true,
		error: null,
		...overrides,
	}
}

function view(
	changes: Array<CredentialApprovalChangeView>,
	enable: Array<CredentialApprovalEnableView> = [],
): CredentialApprovalView {
	return {
		ok: true,
		package: { id: 'pkg', kodyId: 'digest' },
		reason: null,
		canApprove: true,
		fingerprint: 'fp',
		changes,
		enable,
		sender: null,
		errors: [],
	}
}

test('changes group as org defaults, your defaults, then each trigger', () => {
	const groups = groupApprovalChanges([
		change({ target: { type: 'trigger', trigger: daily }, needKey: 'slack' }),
		change({ target: { type: 'default', layer: 'mine' }, needKey: 'openai' }),
		change({ needKey: 'github' }),
		change({ target: { type: 'trigger', trigger: daily }, needKey: 'openai' }),
		change({
			target: { type: 'trigger', trigger: { kind: 'webhook', name: 'daily' } },
		}),
	])
	expect(
		groups.map((group) => [group.key, group.changes.map(({ index }) => index)]),
	).toEqual([
		['default:org', [2]],
		['default:mine', [1]],
		['trigger:["cron","daily"]', [0, 3]],
		['trigger:["webhook","daily"]', [4]],
	])
})

test('credential changes distinguish no-ops from inherited, unusable, or failed mappings', () => {
	expect(approvalChangeIsNoop(change({ before: [bot] }))).toBe(true)
	expect(approvalChangeIsNoop(change({ before: null }))).toBe(false)
	expect(approvalChangeIsNoop(change({ before: [mine] }))).toBe(false)
	expect(
		approvalChangeIsNoop(change({ before: [bot, mine], after: [mine, bot] })),
	).toBe(false)
	expect(
		approvalChangeIsNoop(
			change({ before: [], after: [], beforeUnusableIds: ['gone-1'] }),
		),
	).toBe(false)
	expect(
		approvalChangeIsNoop(
			change({
				before: [],
				after: [],
				error: { code: 'credential_not_found', message: 'No such credential.' },
			}),
		),
	).toBe(false)
})

test('problems include link and change errors', () => {
	const broken = {
		...view([
			change({
				error: { code: 'credential_not_found', message: 'No such credential.' },
			}),
		]),
		errors: ['"default[]" is missing a name.'],
	}
	const problems = approvalProblems(broken)
	expect(problems).toEqual([
		'"default[]" is missing a name.',
		'github: No such credential.',
	])
})

test('enable errors are problems too', () => {
	const broken = view(
		[],
		[
			enableEntry({
				error: {
					code: 'webhook_not_minted',
					message: 'Mint this webhook first.',
				},
			}),
		],
	)
	expect(approvalProblems(broken)).toEqual([
		'Webhook “incoming”: Mint this webhook first.',
	])
})
