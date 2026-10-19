import type { Atom } from 'claude-code'
import { atom } from 'claude-code'
import type { G13Slot } from '../../types/index'

export class SlotHolder {
  readonly slot: Atom<G13Slot>
  constructor(readonly id: string) {
    this.slot = atom({ plugin: 'g13', key: 'slots', id } as const, { n: 0 })
  }
}
