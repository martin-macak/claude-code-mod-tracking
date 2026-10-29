# Drop text that is no command from a shell command. Part of scripts/hooks/verify-gate.sh.
#
# Reads the command on stdin and prints it again. A heredoc body (the lines after the
# operator line, up to and including the terminator line) and a quoted string that
# holds a newline are text, not commands. The gate must not match a push in them.
# The operator line and the quotes stay.
#
# A body or a string is dropped only when the scan can show that nothing runs it. The
# command that owns it must only read text, and its text must not run later:
#   - the owner is cat, tee, echo, printf, git commit|tag|notes, or gh pr|issue|
#     release|gist|api. It is the first word, as plain text: no variable, quote,
#     wrapper (env, sudo), assignment in front or path (but /usr/bin/ and /bin/).
#     printf -v stores its text in a variable, so it is no owner;
#   - the owner is not in a pipeline, in either direction, and not in a ( ) group;
#   - when the owner sits in $( ) or a backtick, the command around it passes the same
#     tests, so `git commit -m "$(cat <<EOF ...)"` is text and `eval "$(cat <<EOF ...)"`
#     is not;
#   - every file the owner writes (> F, >> F, tee F) is plain text, has no shell
#     extension (.sh, .bash, .zsh, .ksh, .dash), is no device or /proc file (but
#     /dev/null, stdout, stderr and tty), and its name appears nowhere in the command
#     after the owner (a file that is written, then run). The name is compared with
#     quotes and backslashes taken out and with case folded: bash r\un and bash RUN run
#     a file named run. A copy to a descriptor other than 1 or 2, or into a process
#     substitution, is not read;
#   - a command that writes a file also keeps its text when the rest of the command may
#     name the file in a way the scan cannot read: a glob, a brace, a substitution or a
#     backtick (* ? [ { $ `), xargs or parallel (they read names from a pipe), or a FIFO
#     in the command (mkfifo, mknod: a reader may open it before the write).
# Any other reader keeps the text: a shell, an interpreter, make, ssh, xargs, a
# variable, a compound command (while read ... done <<EOF), or a command we do not know.
# The scan follows quotes, $( ), ( ), $(( )) and comments. A << inside one of them, or a
# <<< here-string, is not a heredoc operator.
#
# More rules that keep the text:
#   - the delimiter is unquoted and the body holds $( or a backtick (the shell expands
#     it and runs the command). A double-quoted string with $ or a backtick is no text;
#   - no terminator line follows (bash then reads to the end of the text);
#   - the command defines a function (name() or function name): the name may stand for
#     cat or git, and run a shell. The ( of name() marks it. The body of a function is a
#     compound command, so the words below mark function name { ... } and the rest;
#   - the command has one of these words, plain and unquoted, at any place: if, while,
#     until, for, select, case, {, exec, eval. A group or a loop can pipe or redirect
#     all the text of its body ({ cat <<EOF ... } | sh, time { ... } | sh), and exec
#     redirects the shell itself. Such a command keeps every body and string in it.
#
# A dropped body leaves its operator as a plain redirect (<<'EOF' becomes <'EOF'), so
# verify-gate-target.awk can still follow the push after it. A kept body keeps <<.
#
# Limits: a case pattern ")" inside $( ) ends that $( ) early. The scan reads one command.
# It cannot see a file, a FIFO or a descriptor that a text command fills in one tool call
# and a later tool call runs. It cannot see a shell that gets file names with no glob, no
# xargs and no name in the text (find . -type f | sh, after chmod -R +x .). A kept body
# costs a deny only when it holds push text, and the deny runs make verify.

BEGIN {
  RS = "\001"; ORS = ""
  META = "*?[{$`" # a name that these can build is not read by the scan
}
{ s = s $0 }
END {
  n = length(s)
  i = 1
  out = ""
  code(0, 0)
  flush()
  for (c = 1; c <= nc; c++) if (cend[c] == "") cend[c] = n + 1
  for (k = 1; k <= nk; k++) ckdrop[k] = ckbody[k] && !nodrop && ok_candidate(k)
  for (m = 1; m <= ns; m++) {
    k = sk[m]
    if (k == 0 || !ckdrop[k]) printf "%s", seg[m]
    else if (sty[m] == "op") printf " <%s", substr(seg[m], 3)
  }
}

# Scan code until the ")" that closes the paren (inparen), or the end of the text. A
# command record has the words of one simple command, its pipes and its redirects.
function code(inparen, outerc,    cc, sc, sinw, swlit, swtxt, srp, c, nx, t, e, pc) {
  sc = curc; sinw = inw; swlit = wlit; swtxt = wtxt; srp = redirpend
  inw = 0; redirpend = 0
  cc = newc(outerc, 0)
  curc = cc
  pc = ""
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\\") { wstart(); wlit = 0; out = out substr(s, i, 2); i += 2; pc = "x"; continue }
    if (c == "'") { wstart(); wlit = 0; sq(); pc = "x"; continue }
    if (c == "\"") {
      wstart(); wlit = 0
      if (!dqcand()) { out = out c; i++; dq() }
      pc = "x"; continue
    }
    if (c == "`") { wstart(); wlit = 0; bt(); pc = "x"; continue }
    if (c == "#" && (pc == "" || pc == " " || pc == "\t" || pc == "\n" || pc == ";" || pc == "&" || pc == "|" || pc == "(" || pc == ")")) {
      e = index(substr(s, i), "\n")
      if (e == 0) { out = out substr(s, i); i = n + 1 } else { out = out substr(s, i, e - 1); i += e - 1 }
      continue
    }
    if (c == "$") {
      nx = substr(s, i + 1, 1)
      wstart(); wlit = 0
      if (nx == "(") {
        if (substr(s, i + 2, 1) == "(") { out = out "$(("; i += 3; arith() } else { out = out "$("; i += 2; code(1, cc); curc = cc }
        pc = "x"; continue
      }
      if (nx == "'") { out = out "$'"; i += 2; ansi(); pc = "x"; continue }
      out = out c; i++; pc = c; continue
    }
    if (c == "(") {
      if (inw || cwn[cc] > 0) nodrop = 1 # name() { ...; }: the name may stand for cat
      wend()
      if (substr(s, i + 1, 1) == "(") { out = out "(("; i += 2; arith() } else { out = out c; i++; code(1, cc); curc = cc }
      pc = ")"; continue
    }
    if (c == ")") {
      wend(); cend[cc] = i; out = out c; i++
      if (inparen) { inw = sinw; wlit = swlit; wtxt = swtxt; redirpend = srp; curc = sc; return }
      cc = newc(outerc, 0); curc = cc; pc = c; continue
    }
    if (c == "\n") {
      wend(); cend[cc] = i; out = out c; i++; pc = c
      cc = newc(outerc, 0); curc = cc
      if (np > 0) bodies()
      continue
    }
    if (c == " " || c == "\t") { wend(); out = out c; i++; pc = c; continue }
    if (c == ";") { wend(); cend[cc] = i; out = out c; i++; pc = c; cc = newc(outerc, 0); curc = cc; continue }
    if (c == "&") {
      nx = substr(s, i + 1, 1)
      if (nx == ">") {
        wend(); out = out "&>"; i += 2
        if (substr(s, i, 1) == ">") { out = out ">"; i++ }
        redirpend = 1; pc = "x"; continue
      }
      wend(); cend[cc] = i
      if (nx == "&") { out = out "&&"; i += 2 } else { out = out c; i++ }
      pc = c; cc = newc(outerc, 0); curc = cc; continue
    }
    if (c == "|") {
      nx = substr(s, i + 1, 1)
      wend(); cend[cc] = i
      if (nx == "|") { out = out "||"; i += 2; cc = newc(outerc, 0) }
      else {
        if (nx == "&") { out = out "|&"; i += 2 } else { out = out c; i++ }
        cpout[cc] = 1
        cc = newc(outerc, 1)
      }
      curc = cc; pc = c; continue
    }
    if (c == "<") {
      nx = substr(s, i + 1, 1)
      if (nx == "<") {
        wend_fd()
        if (substr(s, i + 2, 1) == "<") { out = out "<<<"; i += 3; redirpend = 2 } else heredoc()
        pc = "x"; continue
      }
      wend_fd(); out = out c; i++
      if (nx == "(") cbad[cc] = 1
      else if (nx == "&" || nx == ">") { out = out nx; i++; redirpend = 2 }
      else redirpend = 2
      pc = "x"; continue
    }
    if (c == ">") {
      nx = substr(s, i + 1, 1)
      wend_fd(); out = out c; i++
      if (nx == ">" || nx == "|") { out = out nx; i++; redirpend = 1 }
      else if (nx == "&") {
        out = out nx; i++
        t = substr(s, i, 1)
        if (t ~ "[0-9-]") {
          e = i
          while (substr(s, e, 1) ~ "[0-9-]") e++
          t = substr(s, i, e - i)
          if (t != "1" && t != "2" && t != "-") cbad[cc] = 1
          out = out t; i = e
        } else redirpend = 1
      }
      else if (nx == "(") cbad[cc] = 1
      else redirpend = 1
      pc = "x"; continue
    }
    wstart()
    if (index("*?[~", c) > 0) wlit = 0
    wtxt = wtxt c
    out = out c; i++; pc = c
  }
  wend()
  inw = sinw; wlit = swlit; wtxt = swtxt; redirpend = srp; curc = sc
}

# A new command record. outerc is the command around it ($( ), ( )), 0 at the top.
function newc(outerc, pin,    id) {
  nc++
  id = nc
  couter[id] = outerc
  cpin[id] = pin
  cst[id] = i
  return id
}

function wstart() {
  if (inw) return
  inw = 1
  wlit = 1
  wtxt = ""
}

# End of a word. It is a word of the command, or the target of a redirect. A word that
# holds a quote, a variable, a glob or an escape is not plain text: "\002".
function wend() {
  if (!inw) return
  inw = 0
  if (redirpend) {
    if (redirpend == 1) crd[curc] = crd[curc] "\n" (wlit ? wtxt : "\002")
    redirpend = 0
    return
  }
  cwn[curc]++
  # exec, eval and the opener of a compound command, as a word at any place (time { ... }
  # and ! if ... put it behind another word): they keep every body and string (see the
  # header).
  if (wlit && wtxt ~ "^(exec|eval|if|while|until|for|select|case|[{])$") nodrop = 1
  if (cwn[curc] <= 8) cw[curc, cwn[curc]] = wlit ? wtxt : "\002"
}

# Before a redirect operator: a number right in front of it is the descriptor, no word.
function wend_fd() {
  if (inw && wlit && wtxt ~ "^[0-9]+$") { inw = 0; return }
  wend()
}

function flush() {
  if (out == "") return
  ns++
  seg[ns] = out
  sk[ns] = 0
  out = ""
}

# A candidate k: a heredoc body, or a string, that the gate may drop.
function newcand(ty) {
  nk++
  ckcmd[nk] = curc
  ckty[nk] = ty
  return nk
}

function addseg(k, ty, text) {
  flush()
  ns++
  seg[ns] = text
  sk[ns] = k
  sty[ns] = ty
}

# Single quotes: copy to the closing quote.
function sq(    e, raw, k) {
  e = index(substr(s, i + 1), "'")
  if (e == 0) { out = out substr(s, i); i = n + 1; return }
  raw = substr(s, i + 1, e - 1)
  if (index(raw, "\n") > 0) {
    out = out "'"
    k = newcand("s")
    ckbody[k] = 1; cks[k] = i + 1; cke[k] = i + e
    addseg(k, "str", raw)
    out = out "'"
  } else out = out substr(s, i, e + 1)
  i += e + 1
}

# A double-quoted string at i (the opening quote). It is a candidate when it holds a
# newline and nothing that expands. Returns 1 when it took the string.
function dqcand(    j, ch, raw, k) {
  j = i + 1
  while (j <= n) {
    ch = substr(s, j, 1)
    if (ch == "\\") { j += 2; continue }
    if (ch == "\"") break
    j++
  }
  if (j > n) return 0
  raw = substr(s, i + 1, j - i - 1)
  if (index(raw, "\n") == 0 || index(raw, "$") > 0 || index(raw, "`") > 0) return 0
  out = out "\""
  k = newcand("s")
  ckbody[k] = 1; cks[k] = i + 1; cke[k] = j
  addseg(k, "str", raw)
  out = out "\""
  i = j + 1
  return 1
}

# Double quotes (the opening quote is done): copy to the closing quote. A $( ) inside is code.
function dq(    c) {
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\\") { out = out substr(s, i, 2); i += 2; continue }
    if (c == "\"") { out = out c; i++; return }
    if (c == "$" && substr(s, i + 1, 1) == "(") {
      if (substr(s, i + 2, 1) == "(") { out = out "$(("; i += 3; arith() } else { out = out "$("; i += 2; code(1, curc) }
      continue
    }
    if (c == "`") { bt(); continue }
    out = out c; i++
  }
}

# Backticks: copy to the closing backtick.
function bt(    c) {
  out = out "`"; i++
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\\") { out = out substr(s, i, 2); i += 2; continue }
    out = out c; i++
    if (c == "`") return
  }
}

# $'...': copy to the closing quote, with backslash escapes.
function ansi(    c) {
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\\") { out = out substr(s, i, 2); i += 2; continue }
    out = out c; i++
    if (c == "'") return
  }
}

# Arithmetic, after the two opening parens: copy to the two closing parens.
function arith(    c, d) {
  d = 2
  while (i <= n) {
    c = substr(s, i, 1)
    out = out c; i++
    if (c == "(") d++
    if (c == ")") { d--; if (d == 0) return }
  }
}

# A << operator: read its delimiter and queue the body for the next newline. The operator
# is a segment of its own: it becomes a plain redirect when its body is dropped.
function heredoc(    j, dash, ch, delim, quoted, k, e) {
  j = i + 2
  dash = 0
  if (substr(s, j, 1) == "-") { dash = 1; j++ }
  while (substr(s, j, 1) == " " || substr(s, j, 1) == "\t") j++
  delim = ""
  quoted = 0
  while (j <= n) {
    ch = substr(s, j, 1)
    if (ch == " " || ch == "\t" || ch == "\n" || ch == ";" || ch == "&" || ch == "|" || ch == "(" || ch == ")" || ch == "<" || ch == ">") break
    if (ch == "'" || ch == "\"") {
      quoted = 1
      k = index(substr(s, j + 1), ch)
      if (k == 0) { delim = ""; break }
      delim = delim substr(s, j + 1, k - 1)
      j += k + 1
      continue
    }
    if (ch == "\\") { quoted = 1; delim = delim substr(s, j + 1, 1); j += 2; continue }
    delim = delim ch
    j++
  }
  if (delim == "") { out = out "<<"; i += 2; return }
  np++
  pd[np] = delim
  pdash[np] = dash
  pq[np] = quoted
  e = newcand("h")
  pk[np] = e
  addseg(e, "op", substr(s, i, j - i))
  i = j
}

# Newline after heredoc operators: take each body, in order. A body that may be text is
# a candidate. Another one stays in the output.
function bodies(    k, p, e, line, nextp, found, bstart, bend, body, kk) {
  for (k = 1; k <= np; k++) {
    kk = pk[k]
    bstart = i
    p = i
    found = 0
    while (p <= n) {
      e = index(substr(s, p), "\n")
      if (e == 0) { line = substr(s, p); nextp = n + 1 } else { line = substr(s, p, e - 1); nextp = p + e }
      if (pdash[k]) sub(/^\t+/, "", line)
      if (line == pd[k]) { found = 1; bend = nextp; break }
      p = nextp
    }
    if (!found) { out = out substr(s, bstart); i = n + 1; np = 0; return }
    body = substr(s, bstart, bend - bstart)
    i = bend
    if (pq[k] || (index(body, "$(") == 0 && index(body, "`") == 0)) {
      ckbody[kk] = 1; cks[kk] = bstart; cke[kk] = bend
      addseg(kk, "body", body)
    } else out = out body
  }
  np = 0
}

# Can the scan show that nothing runs the candidate k? It can when its owner only reads text.
function ok_candidate(k,    c, later) {
  c = ckcmd[k]
  if (ckty[k] == "h") later = substr(s, cend[c], cks[k] - cend[c]) substr(s, cke[k])
  else later = substr(s, cend[c])
  return chain_ok(c, later)
}

# The command c, and the commands around it, only read text. later is the text after c.
function chain_ok(c, later) {
  if (!sink(c) || cpin[c] || cpout[c] || cbad[c]) return 0
  if (!files_ok(c, later)) return 0
  if (couter[c] == 0) return 1
  return chain_ok(couter[c], substr(s, cend[couter[c]]))
}

# The first word of c is a command that only reads text.
function sink(c,    w, sub1) {
  if (cwn[c] < 1) return 0
  w = cw[c, 1]
  # printf -v VAR stores the text in a variable that a later command may run.
  if (w ~ "^(/usr/bin/|/bin/)?printf$" && substr(s, cst[c], cend[c] - cst[c]) ~ "[ \t][\"']?-[a-zA-Z]*v") return 0
  if (w ~ "^(/usr/bin/|/bin/)?(cat|tee|echo|printf)$") return 1
  if (w == "git") {
    sub1 = cw[c, 2]
    if (sub1 == "-C") sub1 = cw[c, 4]
    return sub1 ~ "^(commit|tag|notes)$"
  }
  if (w == "gh") return cw[c, 2] ~ "^(pr|issue|release|gist|api)$"
  return 0
}

# Every file that c writes is plain text, and nothing later uses it. A word after the
# eighth is not stored: it reads as an empty word, and an empty name is no plain file.
# later is the text after c. t is the same text with quotes and backslashes taken out
# and in lower case (see squash).
function files_ok(c, later,    j, m, r, w, t) {
  t = squash(later)
  wrote = 0
  if (cw[c, 1] ~ "^(/usr/bin/|/bin/)?tee$") {
    for (j = 2; j <= cwn[c]; j++) {
      w = cw[c, j]
      if (w ~ "^-") continue
      if (!file_ok(w, t)) return 0
    }
  }
  m = split(crd[c], r, "\n")
  for (j = 2; j <= m; j++) if (!file_ok(r[j], t)) return 0
  if (wrote && other_name(later, t)) return 0
  return 1
}

function file_ok(w, t,    b) {
  if (w == "\002") return 0
  if (w ~ "^/dev/(null|stdout|stderr|tty)$") return 1
  if (w ~ "^/(dev|proc)/") return 0 # a descriptor or a device may feed a shell
  if (w ~ "\\.(sh|bash|zsh|ksh|dash)$") return 0
  wrote = 1
  b = tolower(w)
  sub(".*/", "", b)
  if (b == "" || b == "." || b == "..") return 0
  return !refers(t, b)
}

# The text with its quotes and backslashes taken out, and in lower case. bash 'r''un',
# "r"un, r\un, r\<newline>un name the file run, and so does RUN on a file system that
# folds case. A name that is spelled out then shows in the text.
function squash(t) {
  gsub("\\\\\n", "", t)
  gsub("\\\\", "", t)
  gsub("'", "", t)
  gsub("\"", "", t)
  return tolower(t)
}

# A command wrote a file. Can the rest of the command (later, and t) name it with text
# that the scan cannot read? A glob, a brace or a substitution builds a name. xargs and
# parallel read names from a pipe. A FIFO in the command may be opened by a reader
# before the write.
function other_name(later, t,    k) {
  for (k = 1; k <= length(META); k++) if (index(later, substr(META, k, 1)) > 0) return 1
  if (t ~ "(^|[^a-z0-9_.-])(xargs|parallel)([^a-z0-9_-]|$)") return 1
  if (sqall == "") sqall = squash(s)
  return index(sqall, "mkfifo") > 0 || index(sqall, "mknod") > 0
}

# The name b stands as a word in the text t.
function refers(t, b,    p, off, lb, pre, post) {
  lb = length(b)
  off = 0
  while ((p = index(substr(t, off + 1), b)) > 0) {
    p += off
    pre = (p == 1) ? "" : substr(t, p - 1, 1)
    post = substr(t, p + lb, 1)
    if (pre !~ "^[A-Za-z0-9_.-]$" && post !~ "^[A-Za-z0-9_-]$") return 1
    off = p
  }
  return 0
}
