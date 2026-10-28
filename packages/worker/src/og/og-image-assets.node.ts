import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const yogaWasmPath = require.resolve('satori/yoga.wasm')

export {
	ensureOgBinaryAssetsReady,
	getBricolageGrotesqueLatin700FontData,
	getKodyBaseDataUri,
	getKodyPrimitivesLanternDataUri,
	getLandingAgentIconDataUri,
	getKodyDiscordDataUri,
	getKodyMarkDataUri,
	getKodyPatternDataUri,
	getWixMadeforTextLatin400FontData,
	resetOgBinaryAssetsCache,
	type OgAssetsFetcher,
} from './og-binary-assets.node.ts'

export { ogResvgWasm } from './og-resvg-wasm.node.ts'

export const ogYogaWasm = await WebAssembly.compile(readFileSync(yogaWasmPath))
