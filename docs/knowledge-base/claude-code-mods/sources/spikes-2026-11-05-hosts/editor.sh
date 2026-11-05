#!/bin/sh
# The EDITOR of the Ctrl+G run: append a marker line to the file and log the call.
echo "$*" >> "${EDITOR_LOG:-/dev/null}"
for f in "$@"; do
  case "$f" in
    -*) ;;
    *) printf '\nEDITED-BY-SPIKE-312 marker line\n' >> "$f" ;;
  esac
done
exit 0
