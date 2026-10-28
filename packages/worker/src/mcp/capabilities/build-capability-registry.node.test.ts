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
			contextRuns: 'deny',
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
			contextRuns: 'deny',
			description: 'a',
			inputSchema: z.object({}),
			handler: noopHandler,
		},
	)
	const codingCollision = defineDomainCapability(capabilityDomainNames.coding, {
		name: 'collision',
		orgPermission: 'none',
		contextRuns: 'deny',
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
				contextRuns: 'deny',
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
			contextRuns: 'deny',
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
			contextRuns: 'deny',
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

test('capability specs expose union input fields and shared required fields', () => {
	const resourceLock = defineDomainCapability(capabilityDomainNames.secrets, {
		name: 'resourceLock',
		orgPermission: 'none',
		contextRuns: 'deny',
		description: 'Narrow a resource to a saved package.',
		inputSchema: z.discriminatedUnion('kind', [
			z.object({
				kind: z.literal('secret'),
				name: z.string(),
				package_id: z.string(),
			}),
			z.object({
				kind: z.literal('secret_provider'),
				provider: z.string(),
				ref: z.string(),
				package_id: z.string(),
			}),
		]),
		handler: noopHandler,
	})
	const registry = buildCapabilityRegistry([
		defineDomain({
			name: capabilityDomainNames.secrets,
			description: 'Secrets.',
			capabilities: [resourceLock],
		}),
	])

	expect(registry.capabilitySpecs.resourceLock?.inputFields).toEqual([
		'kind',
		'name',
		'package_id',
		'provider',
		'ref',
	])
	expect(registry.capabilitySpecs.resourceLock?.requiredInputFields).toEqual([
		'kind',
		'package_id',
	])
})
