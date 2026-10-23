import { expect, test } from 'vitest'
import { z } from 'zod'
import { buildCapabilityRegistry } from './build-capability-registry.ts'
import { defineDomain } from './define-domain.ts'
import { defineDomainCapability } from './define-domain-capability.ts'
import { capabilityDomainNames } from './domain-metadata.ts'
import { type CapabilityContext } from './types.ts'

const noopHandler = async (
	_args: Record<string, unknown>,
	_ctx: CapabilityContext,
) => ({})

test('capability domain registration rejects mismatched and duplicate invariants', () => {
	const misplacedCapability = defineDomainCapability(
		capabilityDomainNames.packages,
		{
			name: 'orphan',
			orgPermission: 'none',
			description: 'test',
			inputSchema: z.object({}),
			handler: noopHandler,
		},
	)
	expect(() =>
		defineDomain({
			name: capabilityDomainNames.coding,
			description: 'coding bucket',
			capabilities: [misplacedCapability],
		}),
	).toThrow(/registered under domain/)

	const packagesCollision = defineDomainCapability(
		capabilityDomainNames.packages,
		{
			name: 'collision',
			orgPermission: 'none',
			description: 'a',
			inputSchema: z.object({}),
			handler: noopHandler,
		},
	)
	const codingCollision = defineDomainCapability(capabilityDomainNames.coding, {
		name: 'collision',
		orgPermission: 'none',
		description: 'b',
		inputSchema: z.object({}),
		handler: noopHandler,
	})
	expect(() =>
		buildCapabilityRegistry([
			defineDomain({
				name: capabilityDomainNames.packages,
				description: 'a',
				capabilities: [packagesCollision],
			}),
			defineDomain({
				name: capabilityDomainNames.coding,
				description: 'c',
				capabilities: [codingCollision],
			}),
		]),
	).toThrow(/Duplicate capability names/)

	const packagesDomain = defineDomain({
		name: capabilityDomainNames.packages,
		description: 'a',
		capabilities: [
			defineDomainCapability(capabilityDomainNames.packages, {
				name: 'only',
				orgPermission: 'none',
				description: 'o',
				inputSchema: z.object({}),
				handler: noopHandler,
			}),
		],
	})
	expect(() =>
		buildCapabilityRegistry([packagesDomain, packagesDomain]),
	).toThrow(/Duplicate domain registration/)
	const firstCapability = defineDomainCapability(
		capabilityDomainNames.packages,
		{
			name: 'dup',
			orgPermission: 'none',
			description: '1',
			inputSchema: z.object({}),
			handler: noopHandler,
		},
	)
	const secondCapability = defineDomainCapability(
		capabilityDomainNames.packages,
		{
			name: 'dup',
			orgPermission: 'none',
			description: '2',
			inputSchema: z.object({}),
			handler: noopHandler,
		},
	)
	expect(() =>
		defineDomain({
			name: capabilityDomainNames.packages,
			description: 'a',
			capabilities: [firstCapability, secondCapability],
		}),
	).toThrow(/Duplicate capability .* in domain/)
})
