#!/bin/sh
# pre-push stage of .pre-commit-config.yaml: the tests before every push.
# Git runs hooks with GIT_DIR, GIT_INDEX_FILE and other GIT_* variables set.
# Tests that run git in a temp repo inherit them and write to this repo's index.
# Clear them, so the tests see a clean environment.
for v in $(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
make test && make e2e-unit
