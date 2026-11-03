# Reads a shell command and prints it the way bash reads its words: quotes and
# backslashes are gone, $'..' and $".." lose the $, and a backslash-newline joins the
# lines. A space or tab inside a quote, or after a backslash, becomes \001, so a quoted
# path with a space stays one word (git -C "a b" push). Used by push_match in
# verify-gate.sh. RS is a byte that no command holds, so the input is one record.
BEGIN {
  RS = "\002"
  sp = sprintf("%c", 1)
}

{
  s = $0
  n = length(s)
  q = ""
  out = ""
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    nx = substr(s, i + 1, 1)
    if (q == "'") {
      if (c == "'") q = ""
      else out = out ((c == " " || c == "\t") ? sp : c)
    } else if (q == "\"") {
      if (c == "\"") q = ""
      else if (c == "\\" && (nx == "\"" || nx == "\\" || nx == "$" || nx == "`")) {
        out = out nx
        i++
      } else if (c == "\\" && nx == "\n") i++
      else out = out ((c == " " || c == "\t") ? sp : c)
    } else if (c == "\\") {
      if (nx == "\n") i++
      else if (i < n) {
        out = out ((nx == " " || nx == "\t") ? sp : nx)
        i++
      }
    } else if (c == "$" && (nx == "'" || nx == "\"")) {
      # ANSI-C or locale quoting: the quote that follows opens as usual
    } else if (c == "'" || c == "\"") q = c
    else out = out c
  }
  printf "%s", out
}
