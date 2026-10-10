import type { EngineInterface } from 'claude-code'
export class Thing { constructor(private $: EngineInterface) {} go() { return this.$.process.run(['gh', '--version']) } }
