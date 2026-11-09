import { useState } from 'react'
import { createSingleFlight } from './single-flight.ts'
export function useSingleFlight() {
	const [run] = useState(createSingleFlight)
	return run
}
