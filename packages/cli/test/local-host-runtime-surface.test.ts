import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
	hostedCapabilityProxySpecialFunctions,
	hostedLocalExecuteRuntimeSurface,
	hostedLocalHostSpecialFunctions,
	localHostImplementedRuntimeMarkers,
} from '../src/local-host-runtime-surface.js'
import {
	createLocalEntrySource,
	createLocalRuntimeModuleSource,
	localGatewayFetchStreamRuntimeSource,
} from '../src/local-runtime-source.js'
import { createPackageLocalRuntimeModuleSource } from '../src/package-local-runtime-source.js'

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../src')

test('hosted local-execute runtime surface lists gatewayFetchStream as a special host method', () => {
	assert.deepEqual(
		[...hostedLocalHostSpecialFunctions],
		['kody.gatewayFetchStream'],
	)
	assert.ok(
		hostedLocalExecuteRuntimeSurface.includes('kody.gatewayFetchStream'),
	)
	assert.ok(hostedCapabilityProxySpecialFunctions.includes('kody.gatewayFetch'))
	assert.ok(
		hostedCapabilityProxySpecialFunctions.includes('kody.authenticatedFetch'),
	)
	assert.ok(
		hostedCapabilityProxySpecialFunctions.includes(
			'kody.oauthClientCredentials',
		),
	)
})

test('CLI --local runtime source implements every hosted special host marker (drift guard)', () => {
	const localRuntime = createLocalRuntimeModuleSource()
	const packageRuntime = createPackageLocalRuntimeModuleSource({
		packageContext: {
			packageId: 'pkg',
			kodyId: 'demo',
			appBasePath: '',
			hostedUrl: 'http://127.0.0.1/',
			assetBasePath: '/_assets',
			clientModuleUrl: null,
		},
		mockStorage: true,
	})
	const entry = createLocalEntrySource()
	const bridgeSource = readFileSync(
		join(srcDir, 'local-runtime-bridge.ts'),
		'utf8',
	)
	const capabilitySource = readFileSync(
		join(srcDir, 'capability-proxy.ts'),
		'utf8',
	)
	const forwardSource = readFileSync(
		join(srcDir, 'local-gateway-fetch-forward.ts'),
		'utf8',
	)

	for (const marker of localHostImplementedRuntimeMarkers) {
		assert.match(
			localRuntime,
			new RegExp(escapeRegExp(marker.sourceMarker)),
			`local runtime missing ${marker.id} marker ${marker.sourceMarker}`,
		)
		assert.match(
			packageRuntime,
			new RegExp(escapeRegExp(marker.sourceMarker)),
			`package-local runtime missing ${marker.id} marker ${marker.sourceMarker}`,
		)
		if (marker.bridgeMarker === '/gateway-fetch') {
			assert.match(entry, /gateway-fetch/)
			assert.match(bridgeSource, /gateway-fetch/)
			assert.match(capabilitySource, /capability-proxy\/gateway-fetch/)
			assert.match(forwardSource, /callCapabilityProxyGatewayFetchStream/)
		}
		if (marker.bridgeMarker === '/call') {
			assert.match(entry, /kody-bridge\/call/)
			assert.match(bridgeSource, /\/call/)
		}
	}
})

test('gatewayFetchStream is a real host method on the kody Proxy (not a JSON /call hop)', () => {
	const source = localGatewayFetchStreamRuntimeSource({
		callUnavailableMessage: 'unavailable',
	})
	assert.match(source, /async function gatewayFetchStream/)
	assert.match(source, /property === 'gatewayFetchStream'/)
	assert.match(source, /X-Kody-Gateway-Url/)
	assert.match(source, /init\.duplex = 'half'/)
	assert.doesNotMatch(
		source,
		/gatewayFetchStream[\s\S]{0,80}__kodyCall\(\['kody', 'gatewayFetchStream'\]/,
	)
})

test('hosted surface list stays alphabetically grouped and unique (edit-guard)', () => {
	const ids = [...hostedLocalExecuteRuntimeSurface]
	assert.equal(ids.length, new Set(ids).size, 'duplicate runtime surface ids')
	// Special host methods that are not Proxy JSON hops must stay listed.
	for (const id of hostedLocalHostSpecialFunctions) {
		assert.ok(ids.includes(id), `missing special host function ${id}`)
	}
})

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
