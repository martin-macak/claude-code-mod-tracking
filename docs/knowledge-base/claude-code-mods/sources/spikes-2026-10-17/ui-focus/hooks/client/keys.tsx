// Spike surface module (G08): shows every key and pointer event the engine hands this Client region.
import type { ClientModule } from 'claude-code'

type State = { renders: number }

let keys: string[] = []
let pointer = 'none'
let frames = 0

const Keys: ClientModule<{ title: string }, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  frames += 1
  if (surface.state === undefined) {
    surface.onKey(ev => {
      keys = [...keys, ev.key + (ev.ctrl ? '+ctrl' : '') + (ev.shift ? '+shift' : '') + (ev.meta ? '+meta' : '')].slice(-6)
      surface.setState({ renders: frames })
      surface.post({ key: ev.key })
    })
    surface.onPointer(ev => {
      pointer = `${ev.type}@${ev.x},${ev.y}`
      surface.setState({ renders: frames })
      if (ev.type === 'down') surface.post({ pointer: pointer })
    })
    surface.setState({ renders: frames })
  }
  return (
    <Box flexDirection="column" borderStyle="round" width={44} height={5}>
      <Text>{`${props.title} ${surface.columns}x${surface.rows}`}</Text>
      <Text>{`keys: ${keys.length === 0 ? '(none)' : keys.join(' ')}`}</Text>
      <Text>{`pointer: ${pointer}`}</Text>
    </Box>
  )
}

export default Keys
