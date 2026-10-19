import type { Manager } from './manager'

/** Shared module singleton. A module variable: lost on hot reload, rebuilt on session.start. */
export const holder: { manager?: Manager } = {}
export const OUT = '<SPIKES>/live-out'
