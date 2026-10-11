// CSI, OSC (BEL or ST end), charset select and single-char escapes.
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[()][0-9A-Za-z]|[@-Z\\-_=>78])/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}
