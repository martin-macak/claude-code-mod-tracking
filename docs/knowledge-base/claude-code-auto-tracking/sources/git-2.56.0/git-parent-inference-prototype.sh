#!/bin/bash
# prototype: for each local branch X in $@ (tracked set S), infer parent among S via branch reflog.
# rule 1: "branch: Created from <name>" where name in S
# rule 2: "Created from HEAD": creation sha c = new-sha of oldest reflog entry; parent = Q in S whose own reflog ever had tip==c (prefer Q whose current tip is a descendant of c)
# rule 3: fork-point depth fallback (reports ambiguity)
S=("$@"); trunk=${TRUNK:-main}
for X in "${S[@]}"; do
  line=$(git reflog show --format='%H %gs' "$X" 2>/dev/null | tail -1); c=${line%% *}; msg=${line#* }
  p=""; how=""
  if [[ "$msg" =~ ^branch:\ Created\ from\ (.*)$ ]]; then n=${BASH_REMATCH[1]}
     for Q in "${S[@]}"; do [[ "$Q" == "$n" ]] && p=$Q && how="reflog-name"; done
     [[ -z "$p" && "$n" != HEAD ]] && how="reflog-name(outside set: $n)"
  fi
  if [[ -z "$p" && "$msg" == "branch: Created from HEAD" ]]; then
     cands=()
     for Q in "${S[@]}"; do [[ "$Q" == "$X" ]] && continue
        git reflog show --format='%H' "$Q" 2>/dev/null | grep -q "^$c" && cands+=("$Q"); done
     if [[ ${#cands[@]} -eq 1 ]]; then p=${cands[0]}; how="reflog-sha-match"
     elif [[ ${#cands[@]} -gt 1 ]]; then p="?${cands[*]}"; how="AMBIGUOUS reflog-sha-match"; fi
  fi
  [[ -z "$how" ]] && how="none (created: $msg)"
  printf '%-24s parent=%-52s via %s\n' "$X" "${p:--}" "$how"
done
