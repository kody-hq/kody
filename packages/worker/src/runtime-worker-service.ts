import { exports as workerExports } from 'cloudflare:workers'
import type { RuntimeWorkerServiceContract } from '@kody-internal/shared/runtime-worker.ts'

export const packageAppRuntimeBridgeMissingMessage =
	'PackageAppRuntimeBridge is not exported on this Worker script. Slim origin must forward package-app construction via RUNTIME_WORKER (servePackageAppRequest); do not construct package apps in-process without the bridge or that forward.'

export const packageAppRuntimeForwardUnavailableMessage =
	'Package app construction is unavailable on this Worker (missing PackageAppRuntimeBridge and RUNTIME_WORKER).'

/**
 * True when this script exports `PackageAppRuntimeBridge` for loopback
 * dynamic-worker construction (runtime worker, platform worker, local
 * `index.ts`). Slim origin (`production-worker.ts`) does not.
 *
 * HTTP package-app traffic is already runtime-owned via
 * `isRuntimeWorkerOwnedRequest` + wholesale `RUNTIME_WORKER.fetch`. This
 * helper is for the remaining in-process hole (stateless MCP
 * `packageAppFetch` → `servePackageAppRequest` on slim origin).
 */
export function hasLocalPackageAppRuntimeBridge() {
	return typeof workerExports.PackageAppRuntimeBridge === 'function'
}

/**
 * Require a local bridge for in-process construction. Prefer forwarding via
 * `RUNTIME_WORKER` on slim origin instead of calling this; do not optional-chain
 * the bridge the way `KodyFetchGateway` is.
 */
export function requireLocalPackageAppRuntimeBridge() {
	if (!hasLocalPackageAppRuntimeBridge()) {
		throw new Error(packageAppRuntimeBridgeMissingMessage)
	}
	return workerExports.PackageAppRuntimeBridge
}

/**
 * Typed `RUNTIME_WORKER` entrypoint (`RuntimeWorkerService`). Null when the
 * binding is absent (single-worker tests / local without the runtime script).
 */
export function getRuntimeWorkerService(
	env: Pick<Env, 'RUNTIME_WORKER'>,
): RuntimeWorkerServiceContract | null {
	if (!env.RUNTIME_WORKER) return null
	return env.RUNTIME_WORKER as unknown as RuntimeWorkerServiceContract
}
