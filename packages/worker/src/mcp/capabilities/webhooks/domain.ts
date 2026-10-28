import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { webhookDeliveryListCapability } from './webhook-delivery-list.ts'
import { webhookListCapability } from './webhook-list.ts'
import { webhookUrlApplyCapability } from './webhook-url-apply.ts'
import { webhookUrlMintCapability } from './webhook-url-mint.ts'
import { webhookUrlRotateCapability } from './webhook-url-rotate.ts'
import { webhookSyntheticDispatchCapability } from './webhook-synthetic-dispatch.ts'

export const webhooksDomain = defineDomain({
	name: capabilityDomainNames.webhooks,
	description:
		'Package-declared inbound webhooks with minted handles. Rotate keeps the previous URL live briefly. Register destinations with webhookUrlApply (http with {{webhookUrl}} substitution after interactive owner confirm; GitHub repo hooks use the Hooks API over http) — credential URLs never appear in tool output.',
	keywords: [
		'webhook',
		'inbound',
		'http callback',
		'package.json#kody.webhooks',
		'sentry',
		'github',
		'http',
		'stripe',
		'signature',
		'hmac',
		'mint',
		'rotate',
		'apply',
		'synthetic',
		'smoke',
	],
	capabilities: [
		webhookListCapability,
		webhookUrlMintCapability,
		webhookUrlRotateCapability,
		webhookUrlApplyCapability,
		webhookDeliveryListCapability,
		webhookSyntheticDispatchCapability,
	],
})
