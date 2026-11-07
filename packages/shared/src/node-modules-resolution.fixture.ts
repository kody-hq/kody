/**
 * Dual-major install tree shaped like `html-to-text@10`: `parser` (think
 * `htmlparser2`) needs nested `codec@7` (think `entities@7`) for
 * `codec/decode`, while `serializer` uses the hoisted `codec@4`, whose
 * `./decode` lacks `fromCodePoint`. `parser` also imports a scoped subpath
 * whose nested v2 picks an `exports` condition. Shared by the resolver unit
 * test, the CLI local bundle test, and the hosted bundle test so all three
 * prove the same tree.
 */
export const dualMajorNodeModulesFixture: Record<string, string> = {
	'package.json': JSON.stringify({
		name: 'dual-major-fixture',
		type: 'module',
		dependencies: { parser: '^10.0.0', serializer: '^2.0.0' },
	}),
	'src/index.ts': [
		"import { parse } from 'parser'",
		"import { serialize } from 'serializer'",
		'export default async function main() {',
		'\treturn { parse: parse(), serialize: serialize() }',
		'}',
	].join('\n'),
	'node_modules/codec/package.json': JSON.stringify({
		name: 'codec',
		version: '4.5.0',
		exports: {
			'.': './lib/index.js',
			'./decode': { import: './lib/decode.js', require: './lib/decode.cjs' },
		},
	}),
	'node_modules/codec/lib/index.js': "export const codecVersion = 'codec@4'\n",
	'node_modules/codec/lib/decode.js':
		"export const decodeVersion = 'codec@4'\n",
	'node_modules/codec/lib/decode.cjs':
		"exports.decodeVersion = 'codec@4:require'\n",
	'node_modules/parser/package.json': JSON.stringify({
		name: 'parser',
		version: '10.1.0',
		module: './esm/index.js',
		main: './cjs/index.js',
		dependencies: { codec: '^7.0.0', '@scope/kit': '^2.0.0' },
	}),
	'node_modules/parser/esm/index.js': [
		"import { fromCodePoint } from 'codec/decode'",
		"import { kitUtil } from '@scope/kit/util'",
		"export function parse() { return fromCodePoint() + '+' + kitUtil() }",
		'',
	].join('\n'),
	'node_modules/parser/cjs/index.js':
		"exports.parse = () => 'parser:cjs-entry-should-not-be-used'\n",
	'node_modules/parser/node_modules/codec/package.json': JSON.stringify({
		name: 'codec',
		version: '7.0.1',
		exports: {
			'./decode': { import: './dist/decode.js', default: './dist/decode.cjs' },
		},
	}),
	'node_modules/parser/node_modules/codec/dist/decode.js':
		"export function fromCodePoint() { return 'codec@7' }\n",
	'node_modules/parser/node_modules/codec/dist/decode.cjs':
		"exports.fromCodePoint = () => 'codec@7:require'\n",
	'node_modules/parser/node_modules/@scope/kit/package.json': JSON.stringify({
		name: '@scope/kit',
		version: '2.0.0',
		exports: {
			'./util': { browser: './util.browser.js', default: './util.js' },
		},
	}),
	'node_modules/parser/node_modules/@scope/kit/util.browser.js':
		"export const kitUtil = () => '@scope/kit@2:browser'\n",
	'node_modules/parser/node_modules/@scope/kit/util.js':
		"export const kitUtil = () => '@scope/kit@2:default'\n",
	'node_modules/@scope/kit/package.json': JSON.stringify({
		name: '@scope/kit',
		version: '1.0.0',
		exports: { './util': './util.js' },
	}),
	'node_modules/@scope/kit/util.js':
		"export const kitUtil = () => '@scope/kit@1'\n",
	'node_modules/serializer/package.json': JSON.stringify({
		name: 'serializer',
		version: '2.0.0',
		main: 'index.js',
	}),
	'node_modules/serializer/index.js': [
		"import { decodeVersion } from 'codec/decode'",
		'export const serialize = () => decodeVersion',
		'',
	].join('\n'),
}

export const dualMajorNodeModulesFixtureResult = {
	parse: 'codec@7+@scope/kit@2:browser',
	serialize: 'codec@4',
}
