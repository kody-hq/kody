import { type McpServerRef } from '@kody-internal/shared/mcp-servers.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineCapability } from '#mcp/capabilities/define-capability.ts'
import { type CapabilityDomain } from '#mcp/capabilities/domain-metadata.ts'
import {
	defineSynthesizedDomain,
	readMcpToolAnnotationHints,
	tokenizeCapabilityKeywords,
} from '#mcp/capabilities/synthesized-domain.ts'
import { type Capability, type DomainSpec } from '#mcp/capabilities/types.ts'
import { wrapDownstreamMcpToolResult } from '#mcp/downstream-mcp-result.ts'
import { assertCredentialUsesDeclared } from '#worker/credentials/credential-need-enforcement.ts'
import { attestedPackageStampFromCaller } from '#worker/credentials/package-stamp.ts'
import { resolveCredential } from '#worker/credentials/resolve-credential.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	mcpServerCapabilityId,
	mcpServerDomainId,
	mcpServerKodyName,
	mcpServerToolName,
} from '#worker/mcp-client/mcp-domain-id.ts'
import {
	formatMcpServerUnavailableMessage,
	getMcpServerStatus,
} from '#worker/mcp-client/status.ts'
import {
	type McpServerSnapshot,
	type McpServerToolDescriptor,
} from '#worker/mcp-client/types.ts'

type McpServerToolCapabilityBinding = {
	capabilityName: string
	serverId: string
	mcpToolName: string
}

export type SynthesizedMcpServerDomain = {
	domain: DomainSpec
	bindings: Record<string, McpServerToolCapabilityBinding>
}

function buildKeywords(tool: McpServerToolDescriptor, ref: McpServerRef) {
	const words = [
		'mcp',
		'server',
		tool.name,
		tool.title ?? '',
		tool.description ?? '',
		ref.name,
	]
	return tokenizeCapabilityKeywords(words)
}

function createCapabilityFromTool(input: {
	tool: McpServerToolDescriptor
	ref: McpServerRef
	domainId: CapabilityDomain
}): { capability: Capability; binding: McpServerToolCapabilityBinding } {
	const { tool, ref, domainId } = input
	const capabilityName = mcpServerCapabilityId({
		ref,
		toolName: tool.name,
	})
	const kodyName = mcpServerKodyName(ref)
	const cleanToolName = mcpServerToolName(tool.name)
	const binding: McpServerToolCapabilityBinding = {
		capabilityName,
		serverId: ref.serverId,
		mcpToolName: tool.name,
	}
	const annotationHints = readMcpToolAnnotationHints(tool.annotations)

	const capability = defineCapability({
		name: capabilityName,
		domain: domainId,
		description:
			tool.description?.trim() ||
			tool.title?.trim() ||
			`MCP server tool ${tool.name}.`,
		keywords: buildKeywords(tool, ref),
		...annotationHints,
		contextRuns: 'allow',
		orgPermission: 'integration:use',
		source: 'mcp-server',
		mcpServer: {
			serverId: ref.serverId,
			serverName: ref.name,
			kodyName,
			mcpToolName: binding.mcpToolName,
			toolName: cleanToolName,
		},
		inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
		...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
		async handler(args, ctx) {
			const orgUserId = ownerIdFromCaller(ctx.callerContext)
			if (!orgUserId) {
				throw new McpCallerError(
					`MCP server capability "${ref.name}:${tool.name}" requires an authenticated user.`,
				)
			}
			// Package exports imported into execute run under the execute
			// callerContext (no storageContext.packageId). The bundler stamp
			// installs ALS secret authority for the callee package id; honor
			// that so resourceLock grants still allow the approved package.
			const { packageStamp } = attestedPackageStampFromCaller({
				storageContext: ctx.callerContext.storageContext,
			})
			// Literal kody.mcp.SERVER names are stamp keys. The connection
			// itself is not checked at the door: client callTool sets
			// serverName to the credential display name, which can differ.
			if (packageStamp?.packageId) {
				await assertCredentialUsesDeclared({
					env: ctx.env,
					request: ctx.callerContext.request,
					orgId: orgUserId,
					packageId: packageStamp.packageId,
					references: [{ use: 'key', key: ref.name }],
				})
			}
			const connection = await resolveCredential({
				env: ctx.env,
				orgId: orgUserId,
				actor: ctx.callerContext.request,
				packageStamp,
				baseUrl: ctx.callerContext.baseUrl,
				credential: {
					use: 'mcp-connection',
					serverId: binding.serverId,
					serverName: ref.name,
					waitUntil: ctx.waitUntil,
				},
			})
			let wrapped: Record<string, unknown> | undefined
			try {
				await connection.callTool({
					toolName: tool.name,
					args: (args ?? {}) as Record<string, unknown>,
					accept(raw) {
						wrapped = wrapDownstreamMcpToolResult(raw, {
							kind: 'mcp-server',
							label: `${ref.name}:${tool.name}`,
						})
					},
				})
			} catch (error) {
				// Content rejection already speaks for itself. Hub failures
				// (auth, schema drift, provider 5xx) stay on mcp-event.
				if (error instanceof McpCallerError) throw error
				const status = await getMcpServerStatus({
					env: ctx.env,
					userId: orgUserId,
					ref,
				}).catch(() => null)
				if (status && (!status.ready || status.toolCount === 0)) {
					throw new McpCallerError(formatMcpServerUnavailableMessage(status), {
						cause: error,
					})
				}
				const message =
					error instanceof Error ? error.message : 'Unknown MCP server error.'
				throw new McpCallerError(
					`MCP server capability "${ref.name}:${tool.name}" failed: ${message}`,
					{ cause: error },
				)
			}
			if (!wrapped) {
				throw new McpCallerError(
					`MCP server capability "${ref.name}:${tool.name}" failed: the tool result was not accepted.`,
				)
			}
			return wrapped
		},
	})

	return { capability, binding }
}

export function synthesizeMcpServerToolDomain(input: {
	ref: McpServerRef
	snapshot: McpServerSnapshot | null
}): SynthesizedMcpServerDomain | null {
	const { ref, snapshot } = input
	if (!snapshot || snapshot.state !== 'ready' || snapshot.tools.length === 0) {
		return null
	}

	const domainId = mcpServerDomainId(ref)
	const domainIdForCapabilities: CapabilityDomain = domainId

	const domainDescription =
		snapshot.instructions?.trim() ||
		`Capabilities discovered from the connected MCP server "${ref.name}".`

	const capabilities: Array<Capability> = []
	const bindings: Record<string, McpServerToolCapabilityBinding> = {}

	for (const tool of snapshot.tools) {
		const { capability, binding } = createCapabilityFromTool({
			tool,
			ref,
			domainId: domainIdForCapabilities,
		})
		capabilities.push(capability)
		bindings[binding.capabilityName] = binding
	}

	return {
		domain: defineSynthesizedDomain({
			name: domainIdForCapabilities,
			description: domainDescription,
			keywords: ['mcp', 'integration'],
			capabilities,
		}),
		bindings,
	}
}
