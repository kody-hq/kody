import { expect, test } from 'vitest'
import {
	linkedArtifactPrefix,
	materializeDependencyArtifactModules,
} from './module-graph-artifacts.ts'
import { dirname, joinPath } from './module-graph-path-basics.ts'

function proxyTo(target: string) {
	return `export * from ${JSON.stringify(target)};\nimport * as __kodyPackageModule from ${JSON.stringify(target)};\nimport { __kodyMeterStaticPackageExport } from "../.__kody_virtual__/runtime.js";\nexport default __kodyMeterStaticPackageExport("pkg", __kodyPackageModule.default);\n`
}

function resolveRelative(fromPath: string, specifier: string) {
	const parts: Array<string> = []
	for (const part of joinPath(dirname(fromPath), specifier).split('/')) {
		if (part === '..') parts.pop()
		else if (part !== '.' && part !== '') parts.push(part)
	}
	return parts.join('/')
}

const ai = linkedArtifactPrefix({
	specifier: 'kody:@u/ai/ask',
	sourceId: 'source-ai',
	publishedCommit: 'commit-ai',
})
const calendar = linkedArtifactPrefix({
	specifier: 'kody:@u/calendar/read',
	sourceId: 'source-calendar',
	publishedCommit: 'commit-calendar',
})
const mail = linkedArtifactPrefix({
	specifier: 'kody:@u/mail/read',
	sourceId: 'source-mail',
	publishedCommit: 'commit-mail',
})
const aiBundle =
	'export default function ask() { return "a large shared bundle" }'

/**
 * A hub artifact as linking used to write it: calendar and mail both import
 * ai, and each linked copy of them carried its own copy of ai nested inside.
 */
function nestedHubArtifactModules() {
	const relativeArtifact = (prefix: string) =>
		`./artifacts/${prefix.slice('.__kody_linked__/artifacts/'.length)}/bundle.js`
	return {
		'bundle.js':
			'import calendar from "./.__kody_linked__/calendar.js";\nimport mail from "./.__kody_linked__/mail.js";\nexport default () => [calendar(), mail()];\n',
		'.__kody_linked__/calendar.js': proxyTo(relativeArtifact(calendar)),
		'.__kody_linked__/mail.js': proxyTo(relativeArtifact(mail)),
		...Object.fromEntries(
			[calendar, mail].flatMap((dependency) => [
				[
					`${dependency}/bundle.js`,
					'import ask from "./.__kody_linked__/ai.js";\nexport default () => ask();\n',
				],
				[`${dependency}/.__kody_linked__/ai.js`, proxyTo(relativeArtifact(ai))],
				[`${dependency}/${ai}/bundle.js`, aiBundle],
			]),
		),
	}
}

test('a composed dependency artifact keeps one copy of each linked package it carries', () => {
	const hub = linkedArtifactPrefix({
		specifier: 'kody:@u/week-run/drive',
		sourceId: 'source-hub',
		publishedCommit: 'commit-hub',
	})
	const modules = materializeDependencyArtifactModules({
		artifactPrefix: hub,
		modules: nestedHubArtifactModules(),
	})
	const copiesOfAi = Object.entries(modules).filter(
		([, source]) => source === aiBundle,
	)
	expect(copiesOfAi.map(([modulePath]) => modulePath)).toEqual([
		`${ai}/bundle.js`,
	])
	expect(
		Object.keys(modules)
			.filter((modulePath) => !modulePath.includes('.__kody_virtual__/'))
			.sort(),
	).toEqual(
		[
			`${hub}/bundle.js`,
			`${hub}/.__kody_linked__/calendar.js`,
			`${hub}/.__kody_linked__/mail.js`,
			`${calendar}/bundle.js`,
			`${calendar}/.__kody_linked__/ai.js`,
			`${mail}/bundle.js`,
			`${mail}/.__kody_linked__/ai.js`,
			`${ai}/bundle.js`,
		].sort(),
	)
	for (const [modulePath, source] of Object.entries(modules)) {
		for (const [, specifier] of source.matchAll(/from "(\.[^"]+)"/g)) {
			if (!specifier || specifier.includes('.__kody_virtual__')) continue
			expect(
				modules[resolveRelative(modulePath, specifier)],
				`${modulePath} imports ${specifier}`,
			).toBeDefined()
		}
	}
})

test('linking the same dependency twice writes the same modules', () => {
	const prefix = linkedArtifactPrefix({
		specifier: 'kody:@u/calendar/read',
		sourceId: 'source-calendar',
		publishedCommit: 'commit-calendar',
	})
	expect(prefix).toBe(calendar)
	const once = materializeDependencyArtifactModules({
		artifactPrefix: prefix,
		modules: { 'bundle.js': aiBundle },
	})
	expect(once).toEqual({ [`${prefix}/bundle.js`]: aiBundle })
})
