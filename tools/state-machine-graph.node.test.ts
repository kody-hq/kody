import { expect, test } from 'vitest'
import {
	extractMachineGraphSource,
	renderStateMachineMermaid,
} from './state-machine-graph.ts'

const definition = (handler: string) =>
	`setup({schemas:{events:{GO:types()}}}).createMachine({id:'probe',initial:'idle',states:{idle:{on:{GO:${handler}}},done:{type:'final'}}})`

test('static and function destinations preserve literal targets and guard labels', () => {
	const graph = extractMachineGraphSource(
		'probe',
		definition(
			`{description:'Allowed',to:({event})=>{if(event.allowed)return {target:'done'};return {context:{n:1}}}}`,
		),
	)
	expect(graph.edges).toEqual([
		{ source: 'idle', event: 'GO', target: 'done', guard: 'Allowed' },
		{
			source: 'idle',
			event: 'GO',
			target: 'idle',
			guard: 'Otherwise (Allowed)',
		},
	])
	expect(graph.declaredEvents).toEqual(['GO'])
	expect(graph.finals).toEqual(['done'])
	expect(renderStateMachineMermaid(graph)).toContain(
		'idle --> done: GO [Allowed]',
	)
	expect(
		extractMachineGraphSource(
			'probe',
			definition(`{target:'done',context:({event})=>({data:event.data})}`),
		).edges[0]?.target,
	).toBe('done')
})

test('empty or forbidden static handlers are excluded, while refused functions remain structural handlers', () => {
	for (const handler of ['{}', 'undefined']) {
		const graph = extractMachineGraphSource('probe', definition(handler))
		expect(graph.edges).toEqual([])
		expect(graph.handlers).toEqual([])
	}
	const graph = extractMachineGraphSource('probe', definition('()=>undefined'))
	expect(graph.edges).toEqual([])
	expect(graph.handlers).toEqual([{ source: 'idle', event: 'GO' }])
})

test.each([
	`{target:destination}`,
	`()=>result`,
	`()=>({target:choose()})`,
	`()=>({...result})`,
	`()=>({['target']:'done'})`,
	`()=>condition?{target:'done'}:undefined`,
	`({event})=>{if(event.allowed)return {target:'done'};return undefined}`,
	`{description:'Allowed',to:()=>{switch(value){case 1:return {target:'done'}}}}`,
	`async()=>({target:'done'})`,
	`{target:'missing'}`,
	`'done'`,
	`[{target:'done'}]`,
	`{matches:{allowed:true},target:'done'}`,
	`{description:'Allowed',to:()=>({target:'done'}),target:'idle'}`,
])('fails closed for unsupported or incomplete handler %s', (handler) => {
	expect(() =>
		extractMachineGraphSource('probe', definition(handler)),
	).toThrow()
})

test('missing, duplicated and dynamically supplied machine definitions cannot silently render', () => {
	expect(() => extractMachineGraphSource('probe', '')).toThrow('found 0')
	expect(() =>
		extractMachineGraphSource(
			'probe',
			definition('{}') + ';' + definition('{}'),
		),
	).toThrow('found 2')
	expect(() =>
		extractMachineGraphSource(
			'probe',
			definition('{}').replace('states:{idle', 'states:{...other,idle'),
		),
	).toThrow('Spreads')
	expect(() =>
		extractMachineGraphSource(
			'probe',
			definition('{}').replace(
				"initial:'idle'",
				"initial:'idle',on:{GO:{target:'done'}}",
			),
		),
	).toThrow('state-local')
})
