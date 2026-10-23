import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { expect, test } from 'vitest'
import {
	capabilitySetsEqual,
	dedupeCapabilityEntries,
	fingerprintCapabilityEntries,
	visitorCredentialIdsByNeedKey,
} from './capability-set.ts'

test('fingerprint ignores via paths and display names', async () => {
	const first = await fingerprintCapabilityEntries([
		{
			kind: 'credential',
			credentialId: 'cred-1',
			name: 'OPENAI_KEY',
			credentialKind: 'secret',
			hosts: ['api.openai.com'],
			via: ['notes'],
		},
	])
	const second = await fingerprintCapabilityEntries([
		{
			kind: 'credential',
			credentialId: 'cred-1',
			name: 'Different display',
			credentialKind: 'secret',
			hosts: ['api.openai.com'],
			via: ['notes', 'helper'],
		},
	])
	expect(first).toBe(second)
	expect(capabilitySetsEqual(first, second)).toBe(true)
})

test('fingerprint changes when hosts or credential id change', async () => {
	const base = await fingerprintCapabilityEntries([
		{
			kind: 'credential',
			credentialId: 'cred-1',
			hosts: ['api.openai.com'],
			via: ['notes'],
		},
	])
	const hostChange = await fingerprintCapabilityEntries([
		{
			kind: 'credential',
			credentialId: 'cred-1',
			hosts: ['api.openai.com', 'cdn.openai.com'],
			via: ['notes'],
		},
	])
	const idChange = await fingerprintCapabilityEntries([
		{
			kind: 'credential',
			credentialId: 'cred-2',
			hosts: ['api.openai.com'],
			via: ['notes'],
		},
	])
	expect(base).not.toBe(hostChange)
	expect(base).not.toBe(idChange)
})

test('sharing a need credential with visitors is part of the fingerprint, per key', async () => {
	const need = {
		kind: 'credential' as const,
		credentialId: 'cred-1',
		source: 'need' as const,
		needKey: 'database',
		credentialKind: 'secret',
		hosts: ['db.example.com'],
		via: ['rooms'],
	}
	const plain = await fingerprintCapabilityEntries([need])
	// Sets without visitor sharing keep the fingerprint they always had.
	expect(plain).toBe(
		await sha256Hex(
			JSON.stringify([
				{
					kind: 'credential',
					credentialId: 'cred-1',
					credentialKind: 'secret',
					hosts: ['db.example.com'],
					placement: null,
				},
			]),
		),
	)
	expect(
		await fingerprintCapabilityEntries([{ ...need, needKey: 'other' }]),
	).toBe(plain)
	const shared = await fingerprintCapabilityEntries([
		{ ...need, ownerCredentialForVisitors: true },
	])
	expect(shared).not.toBe(plain)
	expect(
		await fingerprintCapabilityEntries([
			{ ...need, needKey: 'other', ownerCredentialForVisitors: true },
		]),
	).not.toBe(shared)
	// The visitor entry never merges into a plain entry for the same credential.
	expect(
		dedupeCapabilityEntries([
			need,
			{ ...need, ownerCredentialForVisitors: true },
		]),
	).toHaveLength(2)
})

test('an approved set lists visitor credentials by need key, ignoring anything else', () => {
	const entries = [
		{
			kind: 'credential',
			credentialId: 'cred-1',
			needKey: 'database',
			ownerCredentialForVisitors: true,
		},
		{
			kind: 'credential',
			credentialId: 'cred-2',
			needKey: 'database',
			ownerCredentialForVisitors: true,
		},
		{ kind: 'credential', credentialId: 'cred-3', needKey: 'github' },
		{ kind: 'storage', storageId: 'pkg' },
		null,
	]
	expect(visitorCredentialIdsByNeedKey(JSON.stringify(entries))).toEqual(
		new Map([['database', new Set(['cred-1', 'cred-2'])]]),
	)
	expect(visitorCredentialIdsByNeedKey('not json')).toEqual(new Map())
	expect(visitorCredentialIdsByNeedKey('{}')).toEqual(new Map())
})

test('dedupe keeps a stable sorted set and prefers longer via', () => {
	const deduped = dedupeCapabilityEntries([
		{
			kind: 'credential',
			credentialId: 'cred-1',
			hosts: ['B.example.com', 'a.example.com'],
			via: ['root'],
		},
		{
			kind: 'credential',
			credentialId: 'cred-1',
			hosts: ['a.example.com', 'b.example.com'],
			via: ['root', 'dep'],
		},
		{
			kind: 'storage',
			storageId: 'pkg-1',
			hosts: [],
			via: ['root'],
		},
	])
	expect(deduped).toHaveLength(2)
	expect(deduped[0]?.via).toEqual(['root', 'dep'])
	expect(deduped[0]?.hosts).toEqual(['a.example.com', 'b.example.com'])
})
