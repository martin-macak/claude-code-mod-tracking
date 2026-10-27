// The control character rule of the preview (issue #57, L2). The engine refuses a whole pane tree when the source of a `Code` or the
// text of a `Markdown` holds a control character other than tab and newline (the 2.1.302 types say so; 2.1.310 let `\r` pass, and
// the design does not rely on that). A file, a diff and a page are outside data, so every string of the preview goes through this
// rule before it is drawn. Pure.
// Design study of issue #57, comment 6414682787 (G9).

/** The replacement character: the engine draws it, and it shows where the data held a character that cannot be drawn. */
const REPLACEMENT = '�'

/** Every C0 control but tab (U+0009) and newline (U+000A), then DEL and the C1 controls. A lone `\r` is among them. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

/**
 * The text as `Code` and `Markdown` accept it: tab and newline stay, a `\r\n` pair becomes `\n` (a Windows file keeps its lines),
 * and every other control character becomes U+FFFD, one for each. Idempotent. Bidi marks and unpaired surrogates are no control
 * characters: the engine draws them on its own.
 */
export function sanitize(text: string): string {
  return text.replaceAll('\r\n', '\n').replace(CONTROL, REPLACEMENT)
}
