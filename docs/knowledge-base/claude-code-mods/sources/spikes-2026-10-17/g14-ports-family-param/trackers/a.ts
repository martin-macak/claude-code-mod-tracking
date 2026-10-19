// A tracker with no `$`: it gets a SlotPort only.
export type SlotPort = {
  get: (id: string) => Promise<{ n: number } | undefined>
  set: (id: string, v: { n: number }) => Promise<void>
}
export type Tracker = { readonly id: string; onBash: (p: SlotPort) => Promise<string> }

export const github: Tracker = {
  id: 'github',
  async onBash(p) {
    const cur = await p.get('github')
    await p.set('github', { n: (cur?.n ?? 0) + 1 })
    return `github=${(await p.get('github'))?.n}`
  },
}
export const jira: Tracker = {
  id: 'jira',
  async onBash(p) {
    const cur = await p.get('jira')
    await p.set('jira', { n: (cur?.n ?? 0) + 10 })
    return `jira=${(await p.get('jira'))?.n}`
  },
}
