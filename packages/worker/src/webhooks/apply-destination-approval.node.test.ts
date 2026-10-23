import { expect, test } from 'vitest'
import {
	buildWebhookApplyDestinationApprovalRequiredMessage,
	buildWebhookApplyDestinationApprovalUrl,
	fingerprintHttpApplyDestination,
	fingerprintHttpApplyDestinationLegacy,
	toHttpApplyDestinationSnapshot,
} from './apply-destination-approval.ts'

test('http apply destination fingerprint is order-stable and change-sensitive', async () => {
	const base = {
		type: 'http' as const,
		url: 'https://hooks.example/register',
		method: 'POST' as const,
		headers: {
			'Content-Type': 'application/json',
			'X-Extra': '1',
		},
		body: '{"url":"{{webhookUrl}}"}',
		secretName: 'hooksToken',
	}
	const reordered = {
		...base,
		headers: {
			'X-Extra': '1',
			'Content-Type': 'application/json',
		},
	}
	const changedBody = {
		...base,
		body: '{"webhookUrl":"{{webhookUrl}}"}',
	}

	const left = await fingerprintHttpApplyDestination(base, {
		credentialId: 'cred-hooks',
	})
	const right = await fingerprintHttpApplyDestination(reordered, {
		credentialId: 'cred-hooks',
	})
	const changed = await fingerprintHttpApplyDestination(changedBody, {
		credentialId: 'cred-hooks',
	})
	expect(left).toBe(right)
	expect(changed).not.toBe(left)
})

test('fingerprint keys auth by credential id, not secret name', async () => {
	const destination = {
		type: 'http' as const,
		url: 'https://hooks.example/register',
		method: 'POST' as const,
		headers: { 'Content-Type': 'application/json' },
		body: '{"url":"{{webhookUrl}}"}',
		secretName: 'hooksToken',
	}
	const sameCredential = await fingerprintHttpApplyDestination(
		{ ...destination, secretName: 'renamedToken' },
		{ credentialId: 'cred-hooks' },
	)
	const original = await fingerprintHttpApplyDestination(destination, {
		credentialId: 'cred-hooks',
	})
	const replacedCredential = await fingerprintHttpApplyDestination(
		destination,
		{
			credentialId: 'cred-hooks-replacement',
		},
	)
	expect(sameCredential).toBe(original)
	expect(replacedCredential).not.toBe(original)
})

test('legacy name-keyed fingerprint differs from credential-id fingerprint', async () => {
	const destination = {
		type: 'http' as const,
		url: 'https://hooks.example/register',
		method: 'POST' as const,
		body: '{"url":"{{webhookUrl}}"}',
		secretName: 'hooksToken',
	}
	const legacy = await fingerprintHttpApplyDestinationLegacy(destination)
	const current = await fingerprintHttpApplyDestination(destination, {
		credentialId: 'cred-hooks',
	})
	expect(legacy).not.toBe(current)
})

test('approval message lists form-encoded {{webhookUrl}} body injection sites', async () => {
	const destinationInput = {
		type: 'http' as const,
		url: 'https://hooks.example/register',
		method: 'POST' as const,
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `callback=${encodeURIComponent('{{webhookUrl}}')}`,
	}
	const destination = toHttpApplyDestinationSnapshot(destinationInput)
	expect(destination.injectionSites).toContain('body')

	const fingerprint = await fingerprintHttpApplyDestination(destinationInput)
	const approvalUrl = buildWebhookApplyDestinationApprovalUrl({
		baseUrl: 'https://heykody.dev',
		handle: 'whh_ep-1',
		fingerprint,
	})
	const message = buildWebhookApplyDestinationApprovalRequiredMessage({
		approvalUrl,
		destination,
	})
	expect(message).toMatch(/injection sites:.*\bbody\b/)
	expect(message).not.toMatch(/injection sites:\s*\(none\)/)
})

test('approval snapshot treats query placeholders as url injection and ignores fragments', () => {
	const withQuery = toHttpApplyDestinationSnapshot({
		type: 'http',
		url: 'https://hooks.example/register?callback={{webhookUrl}}',
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: '{"ok":true}',
	})
	expect(withQuery.injectionSites).toContain('url')

	const fragmentOnly = toHttpApplyDestinationSnapshot({
		type: 'http',
		url: 'https://hooks.example/register#{{webhookUrl}}',
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: '{"ok":true}',
	})
	expect(fragmentOnly.injectionSites).not.toContain('url')
})
