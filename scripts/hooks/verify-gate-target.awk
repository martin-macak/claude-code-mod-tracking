# Find the directory of each push in a shell command. Part of scripts/hooks/verify-gate.sh.
#
# Reads one command on stdin (a heredoc body or a string that is text is already gone,
# and its operator is a plain redirect: see verify-gate-heredoc.awk). It follows the
# working directory through cd, git -C and subshells, and finds each simple command
# that is `git [options] push` or `gh stack <sub>`, where <sub> is one of the pushing
# subcommands (-v gh_stack_push=REGEX, the one list in verify-gate.sh).
#   stdout   the command, with each push whose directory is known cut down to ":"
#   out_dirs a file (-v out_dirs=FILE): one directory per cut push. A relative one
#            is relative to the directory the command starts in. A leading "!" says
#            that another command ran before the push: it may have changed the target.
# The gate reads stdout again. A push still in it has an unknown directory, and the
# gate checks the session repo for it. So every doubt means "unknown", never "pass":
#   - The scan gives up (prints the command as it came, writes no directory) on text
#     it cannot follow: $( ), backticks, <( ), a heredoc operator, an arithmetic
#     (( )), a function, a case or brace group or other keyword, an unbalanced quote
#     or paren, or a ( that does not start a command.
#   - A directory counts only when it is literal text: letters, digits and . _ / @ % + : , = space.
#     No variable, glob, tilde, brace or leading dash.
#   - A cd counts only when nothing can skip it. A cd that follows another command, or
#     another cd, in an && list makes the directory unknown after the list (the push in
#     the same list is still sure: it runs only after the cd). A cd that follows || or |
#     in a list, or that runs in the background, never counts: bash may skip it or run
#     it in a pipe, and a later command still runs. So do pushd, popd, eval, source, .,
#     builtin, command, exec, a variable assignment in front of a command, and cd with
#     no or odd arguments.
#   - A cd path with a part like x/.. is unknown. In bash, cd x/.. fails when x is
#     missing, and cd -P x/.. goes to the parent of the target of a symlink x. The same
#     holds for a cd .. after a cd into x. A leading .. is fine: cd .. goes up.
#   - A push after another command has a "!" in front of its directory (see out_dirs).
#     The gate then does not trust "no repo here": that command may have made one.
#   - Only `git`, with the options -C, -c, --no-pager, -P and a few like them, and
#     `gh stack` count as a push. A wrapper (env, sudo, timeout, bash -c, xargs) does
#     not, and neither does an option that moves the repo (--git-dir, --work-tree).
# A ( ) subshell keeps its cd to itself. A -C reaches only its own command.

BEGIN { RS = "\001"; ORS = "" }
{ s = s $0 }
END {
  run()
  finish()
}

function run(    c, nx, e) {
  n = length(s)
  i = 1
  cwd = "."
  copied = 1
  res = ""
  while (i <= n && !bail) {
    c = substr(s, i, 1)
    nx = substr(s, i + 1, 1)
    if (c == " " || c == "\t") { endword(); i++; continue }
    if (c == "\n") {
      endword()
      if (!pend_op) { endstmt(); closelist(); after_paren = 0 }
      i++
      continue
    }
    if (c == ";") {
      if (nx == ";") { bail = 1; break }
      endword(); endstmt(); closelist()
      pend_op = 0; after_paren = 0; i++
      continue
    }
    if (c == "&") {
      if (nx == "&") { endword(); endstmt(); pend_op = 1; after_paren = 0; i += 2; continue }
      if (nx == ">") {
        endword(); i += 2
        if (substr(s, i, 1) == ">") i++
        redir_pending = 1
        continue
      }
      endword(); endstmt(); weak(); nocd = 0; pend_op = 0; i++
      continue
    }
    if (c == "|") {
      endword(); endstmt(); weak(); nocd = 1; pend_op = 1
      if (nx == "|" || nx == "&") i += 2; else i++
      continue
    }
    if (c == "(") {
      if (nx == "(" || inword || nw > 0) { bail = 1; break }
      sp++
      stcwd[sp] = cwd; stld[sp] = ldirty; stln[sp] = lnoncd; stnc[sp] = nocd
      ldirty = 0; lnoncd = 0; nocd = 0; pend_op = 0; after_paren = 0
      i++
      continue
    }
    if (c == ")") {
      endword(); endstmt()
      if (sp == 0) { bail = 1; break }
      cwd = stcwd[sp]; ldirty = stld[sp]; lnoncd = stln[sp]; nocd = stnc[sp]; sp--
      lnoncd = 1
      after_paren = 1; pend_op = 0; i++
      continue
    }
    if (c == "<" || c == ">") { redirect(c); continue }
    if (c == "#" && !inword) {
      e = index(substr(s, i), "\n")
      if (e == 0) i = n + 1; else i += e - 1
      continue
    }
    if (c == "\\") {
      if (nx == "") { bail = 1; break }
      if (nx == "\n") { i += 2; continue }
      startword(); cur = cur nx; i += 2
      continue
    }
    startword()
    if (c == "'") {
      e = index(substr(s, i + 1), "'")
      if (e == 0) { bail = 1; break }
      cur = cur substr(s, i + 1, e - 1); i += e + 1
      continue
    }
    if (c == "\"") { i++; dq(); continue }
    if (c == "`") { bail = 1; break }
    if (c == "$") {
      if (nx == "(") { bail = 1; break }
      curbad = 1
      if (nx == "'") {
        e = i + 2
        while (e <= n && substr(s, e, 1) != "'") { if (substr(s, e, 1) == "\\") e++; e++ }
        if (e > n) { bail = 1; break }
        cur = cur substr(s, i, e - i + 1); i = e + 1
        continue
      }
      cur = cur c; i++
      continue
    }
    if (c == "*" || c == "?" || c == "[" || c == "{" || (c == "~" && cur == "")) curbad = 1
    cur = cur c
    i++
  }
  if (!bail) {
    endword(); endstmt()
    if (sp != 0 || redir_pending) bail = 1
  }
}

function startword() {
  if (inword) return
  if (after_paren) { bail = 1; return }
  inword = 1
  pend_op = 0
  cur = ""
  curbad = 0
  curst = i
}

function endword() {
  if (!inword) return
  inword = 0
  if (redir_pending) { redir_pending = 0; return }
  nw++
  wval[nw] = cur
  wbad[nw] = curbad
  wst[nw] = curst
  wen[nw] = i - 1
}

# Double quotes (the opening quote is done).
function dq(    d, e) {
  while (1) {
    if (i > n) { bail = 1; return }
    d = substr(s, i, 1)
    if (d == "\"") { i++; return }
    if (d == "\\") {
      e = substr(s, i + 1, 1)
      if (e == "\"" || e == "\\" || e == "$" || e == "`") { cur = cur e; i += 2 }
      else if (e == "\n") i += 2
      else { cur = cur "\\"; i++ }
      continue
    }
    if (d == "`") { bail = 1; return }
    if (d == "$") {
      e = substr(s, i + 1, 1)
      if (e == "(") { bail = 1; return }
      if (e != "\"" && e != "") curbad = 1
    }
    cur = cur d
    i++
  }
}

# A redirection. A digit word right before it is the file descriptor. The target
# word is read as the next word and dropped. A heredoc and a process substitution give up.
function redirect(c,    t) {
  if (inword && cur ~ "^[0-9]+$" && !curbad) inword = 0
  else endword()
  i++
  t = substr(s, i, 1)
  if (c == ">" && (t == ">" || t == "|")) i++
  else if (c == "<" && t == ">") i++
  else if (c == "<" && t == "<") {
    if (substr(s, i + 1, 1) == "<") i += 2
    else { bail = 1; return }
  }
  t = substr(s, i, 1)
  if (t == "(") { bail = 1; return }
  if (t == "&") {
    i++
    if (substr(s, i, 1) ~ "[0-9-]") {
      while (i <= n && substr(s, i, 1) ~ "[0-9-]") i++
      return
    }
  }
  redir_pending = 1
}

# An operator that makes the next command run on its own or only sometimes: the
# directory is unknown from here until a cd sets it.
function weak() {
  cwd = "?"
}

# End of an && list (at ; or a newline): a cd that may not have run leaves the directory unknown.
function closelist() {
  if (ldirty) cwd = "?"
  ldirty = 0
  lnoncd = 0
  nocd = 0
}

function endstmt() {
  if (nw == 0) return
  stmt()
  nw = 0
}

function stmt(    w1, k) {
  w1 = wval[1]
  if (w1 ~ "^(if|then|else|elif|fi|while|until|do|done|for|case|esac|select|function|\\{|\\}|!|\\[\\[|time|coproc|in)$") { bail = 1; return }
  if (!wbad[1] && w1 == "cd") { docd(); return }
  pran = ran
  ran = 1
  if (wbad[1] || w1 == "" || w1 ~ "^[A-Za-z_][A-Za-z0-9_]*=") { cwd = "?"; lnoncd = 1; return }
  if (w1 ~ "^(pushd|popd|eval|source|\\.|builtin|command|exec)$") { cwd = "?"; lnoncd = 1; return }
  k = pushend()
  lnoncd = 1
  if (k > 0 && pdir != "?") {
    nd++
    dirs[nd] = (pran ? "!" : "") pdir
    res = res substr(s, copied, wst[1] - copied) ":"
    copied = wen[k] + 1
  }
}

function docd(    idx, d) {
  # A cd on the right of || or |, or after one in the same list, may be skipped or may
  # run in a pipe. A later command may still run in the old directory.
  if (nocd) { cwd = "?"; lnoncd = 1; return }
  idx = 2
  while (idx <= nw && !wbad[idx] && (wval[idx] == "-P" || wval[idx] == "-L")) idx++
  if (idx <= nw && !wbad[idx] && wval[idx] == "--") idx++
  d = wval[idx]
  if (nw - idx + 1 != 1 || wbad[idx] || !clean(d)) { cwd = "?"; lnoncd = 1; return }
  collapsed = 0
  if (substr(d, 1, 1) == "/") cwd = norm(d)
  else if (cwd != "?") cwd = norm(cwd "/" d)
  if (collapsed) { cwd = "?"; lnoncd = 1; return }
  if (lnoncd) ldirty = 1
  lnoncd = 1 # a later cd in this list runs only if this one worked
}

# The index of the last word of a push command (git [options] push, gh stack ...), or
# 0 when the statement is no push. Sets pdir to its directory ("?" when unknown).
function pushend(    b, idx, w, d) {
  b = wval[1]
  sub(".*/", "", b)
  pdir = cwd
  if (b == "gh") {
    if (nw >= 3 && !wbad[2] && !wbad[3] && wval[2] == "stack" && wval[3] ~ ("^(" gh_stack_push ")$")) return 3
    return 0
  }
  if (b != "git") return 0
  idx = 2
  while (idx <= nw) {
    if (wbad[idx]) return 0
    w = wval[idx]
    if (w == "-C") {
      if (idx + 1 > nw) return 0
      d = wval[idx + 1]
      if (wbad[idx + 1] || !clean(d) || pdir == "?") pdir = "?"
      else pdir = (substr(d, 1, 1) == "/") ? d : pdir "/" d
      idx += 2
      continue
    }
    if (w == "-c") {
      if (idx + 1 > nw) return 0
      idx += 2
      continue
    }
    if (w ~ "^(--no-pager|-P|--paginate|-p|--no-optional-locks|--no-replace-objects|--literal-pathspecs)$") { idx++; continue }
    if (w == "push") return idx
    return 0
  }
  return 0
}

# A directory that is plain text: no variable, glob, tilde, brace or leading dash.
function clean(d) {
  return d ~ "^[A-Za-z0-9_./@%+:,= ][A-Za-z0-9_./@%+:,= -]*$"
}

# Textual path: drop ".", "" and "x/..", as bash does for cd. A leading ".." stays.
# Sets collapsed when it drops an x/..: bash needs x to exist, and x may be a symlink.
function norm(p,    abs, m, k, q, cnt, r) {
  abs = (substr(p, 1, 1) == "/")
  m = split(p, parts, "/")
  split("", st)
  cnt = 0
  for (k = 1; k <= m; k++) {
    q = parts[k]
    if (q == "" || q == ".") continue
    if (q == "..") {
      if (cnt > 0 && st[cnt] != "..") { cnt--; collapsed = 1; continue }
      if (abs) continue
    }
    st[++cnt] = q
  }
  if (cnt == 0) return abs ? "/" : "."
  r = abs ? "" : st[1]
  for (k = abs ? 1 : 2; k <= cnt; k++) r = r "/" st[k]
  return r
}

function finish(    k) {
  if (bail) { printf "%s", s; return }
  printf "%s", res substr(s, copied)
  for (k = 1; k <= nd; k++) printf "%s\n", dirs[k] > out_dirs
  close(out_dirs)
}
