import { expect, test } from 'vitest'
import { buildPackageAppCustomHostnameSetup } from './setup-instructions.ts'

test('setup lists the CNAME plus TXT records, all DNS only, with relative names', () => {
	const setup = buildPackageAppCustomHostnameSetup({
		hostname: 'apps.example.co.uk',
		bindingKind: 'app',
		cnameTarget: 'domains.kody.run',
		ownershipVerification: {
			type: 'txt',
			name: '_cf-custom-hostname.apps.example.co.uk',
			value: 'owner',
		},
		sslValidationRecords: [
			{ type: 'txt', name: '_acme-challenge.apps.example.co.uk', value: 'a' },
			{ type: 'txt', name: '_acme-challenge.apps.example.co.uk', value: 'a' },
			{
				type: 'http',
				name: 'http://apps.example.co.uk/.well-known/x',
				value: 'b',
			},
		],
	})
	expect(
		setup.records.map((record) => [
			record.type,
			record.relative_name,
			record.value,
			record.proxy,
		]),
	).toEqual([
		['CNAME', 'apps', 'domains.kody.run', 'dns_only'],
		['TXT', '_cf-custom-hostname.apps', 'owner', 'dns_only'],
		['TXT', '_acme-challenge.apps', 'a', 'dns_only'],
	])
	expect(setup.steps[1]).toMatch(/3 records/)
	expect(setup.provider_notes.join('\n')).toMatch(/grey cloud/)
})

test('a root hostname uses @ and a missing CNAME target still explains the record', () => {
	const setup = buildPackageAppCustomHostnameSetup({
		hostname: 'example.com',
		bindingKind: 'app',
		cnameTarget: null,
		ownershipVerification: null,
		sslValidationRecords: [],
	})
	expect(setup.records).toEqual([])
	expect(setup.steps[1]).toMatch(/Add a CNAME/)
	const withTarget = buildPackageAppCustomHostnameSetup({
		hostname: 'example.com',
		bindingKind: 'app',
		cnameTarget: 'domains.kody.run',
		ownershipVerification: null,
		sslValidationRecords: [],
	})
	expect(withTarget.records[0]?.relative_name).toBe('@')
})

test('TXT setups stage the CNAME switch for live hostnames and missing targets are called out', () => {
	const txt = buildPackageAppCustomHostnameSetup({
		hostname: 'apps.example.com',
		bindingKind: 'app',
		cnameTarget: null,
		ownershipVerification: {
			type: 'txt',
			name: '_cf-custom-hostname.apps.example.com',
			value: 'owner',
		},
		sslValidationRecords: [],
	})
	expect(txt.records.map((record) => record.type)).toEqual(['TXT'])
	expect(txt.steps.join('\n')).toMatch(/no routing target configured/)
	const staged = buildPackageAppCustomHostnameSetup({
		hostname: 'apps.example.com',
		bindingKind: 'app',
		cnameTarget: 'domains.kody.run',
		ownershipVerification: {
			type: 'txt',
			name: '_cf-custom-hostname.apps.example.com',
			value: 'owner',
		},
		sslValidationRecords: [],
	})
	expect(staged.steps.join('\n')).toMatch(
		/publish the TXT records first.*only then switch the CNAME/,
	)
})

test('org bindings point at /packages/{kodyId} and gone hostnames say delete and add again', () => {
	const org = buildPackageAppCustomHostnameSetup({
		hostname: 'team.example.com',
		bindingKind: 'org',
		cnameTarget: 'domains.kody.run',
		ownershipVerification: null,
		sslValidationRecords: [],
	})
	expect(org.steps.at(-1)).toContain(
		'https://team.example.com/packages/{kodyId}',
	)
	const gone = buildPackageAppCustomHostnameSetup({
		hostname: 'team.example.com',
		bindingKind: 'org',
		cnameTarget: 'domains.kody.run',
		gone: true,
		ownershipVerification: null,
		sslValidationRecords: [],
	})
	expect(gone.records).toEqual([])
	expect(gone.steps.join('\n')).toMatch(
		/Delete this custom hostname.*add it again/,
	)
})
