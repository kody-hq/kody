import psList from 'ps-list'
import { hostCatalog, type HostDefinition } from './host-catalog.js'
import type { ProcessInfo } from './process-info.js'

export async function listRunningProcesses(): Promise<Array<ProcessInfo>> {
	const processes = await psList()
	return processes.map((process) => ({
		name: process.name,
		cmd: process.cmd,
	}))
}

export function detectRunningHosts(
	processes: Array<ProcessInfo>,
	catalog: ReadonlyArray<HostDefinition> = hostCatalog,
): Array<HostDefinition> {
	return catalog.filter((host) =>
		processes.some((process) => host.matches(process)),
	)
}
