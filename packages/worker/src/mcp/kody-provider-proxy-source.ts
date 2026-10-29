import {
	assertGeneratedExecutorSourceIsBundleSafe,
	kodyRemoteProxyFactorySource,
} from '#mcp/kody-remote-proxy-source.ts'
import { secretAuthorityArgName } from '#mcp/secrets/secret-authority.ts'
import {
	buildKodyFlatCapabilityUnavailableMessage,
	kodyCapabilityNamespaceConfigs,
} from '#mcp/kody-capability-accessors.ts'
import {
	kodyCallDispatcherName,
	kodyProviderEvaluateBindingName,
} from '#worker/kody-evaluate-bindings.ts'

export type KodyRemoteProxyEvaluateMetadata = {
	name: string
	status: {
		connected: boolean
		toolCount: number
		unavailableMessage: string
	}
	capabilities: Array<{
		name: string
		dispatchName: string
	}>
}

/**
 * Fields the sandbox MCP proxy reads. Live `connected` / `toolCount` /
 * `unavailableMessage` travel on `evaluate` RPC so they do not remint
 * WorkerCode.
 */
export function projectKodyRemoteProxyMetadata(
	entries: ReadonlyArray<{
		name: string
		status: {
			connected: boolean
			toolCount: number
			unavailableMessage: string
		}
		capabilities: ReadonlyArray<{
			name: string
			dispatchName: string
		}>
	}>,
): Array<KodyRemoteProxyEvaluateMetadata> {
	return entries.map((entry) => ({
		name: entry.name,
		status: {
			connected: entry.status.connected,
			toolCount: entry.status.toolCount,
			unavailableMessage: entry.status.unavailableMessage,
		},
		capabilities: entry.capabilities.map((capability) => ({
			name: capability.name,
			dispatchName: capability.dispatchName,
		})),
	}))
}

export function createKodyProviderProxySource(input: { providerName: string }) {
	const mcpFlatNameMessage = buildKodyFlatCapabilityUnavailableMessage({
		namespace: 'mcp',
		flatToolName: '${normalizedToolName}',
	})
	const mcpFlatNamePrefix = kodyCapabilityNamespaceConfigs.mcp.flatNamePrefix
	const source = `    const __kodyCreateRemoteProxy = ${kodyRemoteProxyFactorySource};
    const ${kodyCallDispatcherName} = async (dispatchName, args) => {
      // Generic dispatcher: never carries package secret authority. A
      // package's own kody calls go through its trusted per-package
      // binding (GHSA-5fv3). Drop any forged reserved field.
      const payload =
        args == null || (typeof args === 'object' && !Array.isArray(args))
          ? (() => {
              const next = { ...(args ?? {}) };
              delete next[${JSON.stringify(secretAuthorityArgName)}];
              return next;
            })()
          : args;
      // A reused isolate can call this from a later run (e.g. a cached
      // createAuthenticatedFetch refreshing a token). This run's stubs are
      // disposed by then, so prefer the calling run's dispatchers.
      const activeRun =
        typeof __kodyEvaluateFetchStorage === 'undefined'
          ? undefined
          : __kodyReflectApplyCaptured(__kodyAlsGetStoreCaptured, __kodyEvaluateFetchStorage, []);
      const dispatcher = activeRun?.dispatchers?.${input.providerName} ?? __dispatchers.${input.providerName};
      const resJson = await dispatcher.call(dispatchName, JSON.stringify(payload ?? {}));
      const data = JSON.parse(resJson);
      if (data.error) throw new Error(data.error);
      return data.result;
    };
    const __kodyMcp = __kodyCreateRemoteProxy({
      entries: Array.isArray(__invocation.mcpServers) ? __invocation.mcpServers : [],
      entityLabel: "MCP server",
      shortEntityLabel: "MCP server",
      capabilityLabel: "MCP tool",
      callTool: ${kodyCallDispatcherName},
    });
    const ${kodyProviderEvaluateBindingName} = new Proxy({}, {
      get: (_, toolName) => {
        if (typeof toolName === 'symbol' || toolName === 'then') return undefined;
        if (toolName === 'mcp') return __kodyMcp;
        const normalizedToolName = String(toolName);
        if (normalizedToolName.startsWith('${mcpFlatNamePrefix}')) {
          throw new Error(\`${mcpFlatNameMessage}\`);
        }
        return async (args) => await ${kodyCallDispatcherName}(normalizedToolName, args);
      },
      has: (_, toolName) => toolName === 'mcp',
      ownKeys: () => ['mcp'],
      getOwnPropertyDescriptor: (_, toolName) => {
        if (toolName !== 'mcp') return undefined;
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: __kodyMcp,
        };
      },
    });`
	assertGeneratedExecutorSourceIsBundleSafe(source)
	return source
}
