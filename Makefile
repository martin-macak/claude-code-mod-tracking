# Makefile for the Claude Code mod in plugins/artifact-tracking.
# Recipes are POSIX sh and run on macOS (BSD tools) and Linux.

PLUGIN ?= plugins/artifact-tracking
NODE   ?= node@24
# Repo root: the folder that holds this Makefile.
ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))

# Absolute path of the plugin. `install` links to it.
PLUGIN_ABS := $(abspath $(PLUGIN))
# Mod id. Read from plugin.json, else the folder name.
NAME := $(shell sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' $(PLUGIN)/.claude-plugin/plugin.json 2>/dev/null | head -n 1)
ifeq ($(NAME),)
NAME := $(notdir $(PLUGIN_ABS))
endif
# A person chooses VERSION only when making the release tag.
VERSION ?=

# Release artifacts. `dist` writes them, the release workflow uploads them.
DIST := $(ROOT)/dist

# Config dir of Claude Code. Same rule as the CLI: $CLAUDE_CONFIG_DIR, else ~/.claude.
CLAUDE_CONFIG_DIR ?= $(HOME)/.claude
SKILLS_DIR := $(CLAUDE_CONFIG_DIR)/skills
LINK       := $(SKILLS_DIR)/$(NAME)

# TypeScript version where mise is absent. Keep it equal to the pin in test.yml.
TYPESCRIPT_VERSION ?= 7.0.2
# Runners. With mise, use mise's $(NODE). Without mise (CI, Copilot, the Claude
# action), use the node on PATH. Override either one on the command line.
ifneq ($(shell command -v mise 2>/dev/null),)
TSC      ?= mise exec $(NODE) -- npx -y -p typescript tsc
NODE_RUN ?= mise exec $(NODE) --
else
TSC      ?= npx -y -p typescript@$(TYPESCRIPT_VERSION) tsc
NODE_RUN ?=
endif

# e2e harness: Gherkin scenarios that drive a real claude in tmux. Spec:
# docs/superpowers/specs/2026-10-11-demo-pipeline-design.md
E2E       := e2e
E2E_STAMP := $(E2E)/node_modules/.package-lock.json
DEMO_GIF  := docs/assets/demo.gif

.DEFAULT_GOAL := help
.PHONY: help init build typecheck test coverage test-scripts check verify project-sync e2e-deps e2e-unit e2e demo lint hooks dist release release-dry marketplace-release install uninstall clean

help: ## List the targets
	@echo "Targets (PLUGIN=$(PLUGIN)):"
	@awk -F':.*## ' '/^[a-z][a-z0-9-]*:.*## /{printf "  %-16s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

init: ## Check the tools, print versions, warm the TypeScript cache
	@ok=1; \
	if command -v claude >/dev/null 2>&1; then printf 'claude   : %s\n' "$$(claude --version)"; \
	else echo 'claude   : MISSING (required)'; ok=0; fi; \
	if command -v mise >/dev/null 2>&1; then \
	  printf 'mise     : %s\n' "$$(mise --version | head -n 1)"; \
	  if v="$$(mise exec $(NODE) -- node --version 2>/dev/null)"; then printf 'node     : %s (via mise, %s)\n' "$$v" '$(NODE)'; \
	  else echo 'node     : MISSING via mise $(NODE) (required). Run: mise use -g $(NODE)'; ok=0; fi; \
	else echo 'mise     : MISSING (optional in this environment)'; fi; \
	for t in gh acli; do \
	  if command -v $$t >/dev/null 2>&1; then printf '%-9s: present (optional)\n' "$$t"; \
	  else printf '%-9s: missing (optional, the mod still works)\n' "$$t"; fi; \
	done; \
	"$(ROOT)/scripts/dev/gh-check.sh"; \
	for t in tmux asciinema agg gifsicle; do \
	  if command -v $$t >/dev/null 2>&1; then printf '%-9s: present (for make e2e / make demo)\n' "$$t"; \
	  else printf '%-9s: missing (needed by make e2e / make demo, brew install %s)\n' "$$t" "$$t"; fi; \
	done; \
	if command -v pre-commit >/dev/null 2>&1; then printf 'pre-commit: %s\n' "$$(pre-commit --version)"; \
	else echo 'pre-commit: missing (needed by make hooks and make lint)'; fi; \
	[ "$$ok" = 1 ] || { echo 'init failed: a required tool is missing.'; exit 1; }; \
	echo 'Warming the TypeScript npx cache...'; \
	printf 'tsc      : %s\n' "$$($(TSC) --version)"

# Nothing is emitted. Claude Code loads the .ts and .tsx files directly,
# so "build" only validates the plugin and type-checks it.
# The second validate reads the repo's marketplace.json, so every PR checks it.
build: ## Validate the plugin and the marketplace, then type-check (no output files)
	cd $(PLUGIN) && claude plugin validate .
	cd "$(ROOT)" && claude plugin validate --strict .
	@$(MAKE) --no-print-directory typecheck

# scripts/coverage takes @types/node from e2e/node_modules, so it needs e2e-deps too.
typecheck: e2e-deps ## Type-check the plugin, the e2e harness and the coverage scripts with tsc (no claude needed)
	cd $(PLUGIN) && $(TSC) -p .
	cd $(E2E) && $(TSC) -p .
	cd scripts/coverage && $(TSC) -p .

# The suite takes about 3 s, so test depends on build.
# The last step is the coverage gate, so the pre-push hook and CI enforce it.
test: build ## Run the plugin tests (after build)
	cd $(PLUGIN) && claude plugin test .
	@$(MAKE) --no-print-directory coverage

# coverage: the kit has no coverage option, so the pure tests also run under node.
# scripts/coverage/loader.mjs maps claude-code/testing to a shim and claude-code to an
# empty stub, and resolves extensionless imports. Rule: node runs every tests/**/*.test.ts
# except *.kit.test.ts. A test that needs $ is .tsx or *.kit.test.ts and only the kit runs it.
# Gate: 90% lines, branches and functions over core, ux, trackers and hooks. register.tsx
# (the composition root) is out; the kit wiring tests cover it. check.mjs then fails when a
# source file is missing from the report, because node reports only the files it loaded.
# Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 7.1.
COVERAGE_FLAGS := --experimental-transform-types --no-warnings --import $(ROOT)/scripts/coverage/loader.mjs \
  --test --experimental-test-coverage \
  --test-coverage-include='core/**' --test-coverage-include='ux/**' \
  --test-coverage-include='trackers/**' --test-coverage-include='hooks/**' \
  --test-coverage-exclude='hooks/register.tsx' --test-coverage-exclude='tests/**' \
  --test-coverage-lines=90 --test-coverage-branches=90 --test-coverage-functions=90 \
  --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=lcov --test-reporter-destination=coverage/lcov.info
coverage: ## Run the pure tests under node with a 90% coverage gate
	cd $(PLUGIN) && mkdir -p coverage && $(NODE_RUN) node $(COVERAGE_FLAGS) $$(find tests -name '*.test.ts' ! -name '*.kit.test.ts' | sort)
	$(NODE_RUN) node $(ROOT)/scripts/coverage/check.mjs $(PLUGIN)/coverage/lcov.info $(PLUGIN)

check: test ## Alias of test (validate, type-check, test)

test-scripts: ## Test the repo scripts (no claude needed)
	scripts/hooks/verify-gate.test.sh
	$(NODE_RUN) node --experimental-transform-types --test scripts/coverage/kit-shim.test.ts scripts/coverage/check.test.mjs
	$(NODE_RUN) node --experimental-transform-types --no-warnings --import $(ROOT)/scripts/coverage/loader.mjs --test scripts/contracts/*.test.mjs
	scripts/dev/gh-check.test.sh
	bash scripts/release/release.test.sh
	bash scripts/release/ci-guards.test.sh
	bash scripts/release/smoke.test.sh
	cd .agents/skills/pr-review && $(NODE_RUN) node --test 'tests/*.test.mjs'
	cd .agents/skills/project-sync && $(NODE_RUN) node --test 'tests/*.test.mjs'

# verify: the gate before every commit and push. Rules: AGENTS.md, "Before you
# commit or push". Lint runs first: its fixers rewrite files. Then the gate fails,
# so you review and stage the fixes before tests run on them.
verify: ## Lint with auto-fix, test, unit-test the e2e harness and the scripts (run before every push)
	@u="$$(git ls-files -o --exclude-standard)"; [ -z "$$u" ] || { \
	  printf 'verify failed: the hooks skip untracked files. git add them or ignore them:\n%s\n' "$$u"; exit 1; }
	@pre-commit run --all-files || { \
	  echo; echo 'verify failed: a hook failed or fixed files. Review the diff, stage it, run make verify again.'; exit 1; }
	@$(MAKE) --no-print-directory test
	@$(MAKE) --no-print-directory e2e-unit
	@$(MAKE) --no-print-directory test-scripts
	@echo 'verify passed: lint, test and e2e-unit are green.'

# project-sync: keeps the GitHub Project current. The skill holds the modes and rules:
# .agents/skills/project-sync/SKILL.md. Plan: AGENTS.md, "Planning and delivery".
# sync, next and add are dry runs unless ARGS has --apply. status writes at once.
# Examples: make project-sync ARGS=next
#   make project-sync ARGS='sync --apply'    make project-sync ARGS='status 64 "In progress"'
ARGS ?= sync
project-sync: ## Run the project-sync skill (ARGS='sync' by default; see its SKILL.md)
	@$(NODE_RUN) node .agents/skills/project-sync/scripts/sync.mjs $(ARGS)

e2e-deps: $(E2E_STAMP) ## Install the e2e harness dependencies (npm ci)

$(E2E_STAMP): $(E2E)/package-lock.json
	cd $(E2E) && $(NODE_RUN) npm ci --no-audit --no-fund

e2e-unit: e2e-deps ## Unit-test the e2e harness (no claude, tmux tests skip without tmux)
	cd $(E2E) && $(NODE_RUN) node --test 'tests/**/*.test.ts'

e2e: e2e-deps ## Run the Gherkin scenarios against a real claude (needs a Claude login, tmux)
	cd $(E2E) && $(NODE_RUN) npx cucumber-js

demo: e2e-deps ## Record the @demo scenario and render docs/assets/demo.gif (at most 2 MB)
	cd $(E2E) && DEMO_RECORD=1 $(NODE_RUN) npx cucumber-js -p demo
	cd $(E2E) && $(NODE_RUN) node bin/render.ts out/demo ../$(DEMO_GIF)

# Linters and hooks live in .pre-commit-config.yaml. Rules: AGENTS.md.
lint: ## Run every pre-commit hook on all files
	pre-commit run --all-files

hooks: ## Install the pre-commit, commit-msg and pre-push git hooks
	pre-commit install --install-hooks

# HEAD files, with the tag version stamped only in the staged archive.
dist: ## Build both release zips and SHA256SUMS; requires VERSION=x.y.z
	@bash "$(ROOT)/scripts/release/dist.sh" "$(VERSION)"

release: ## Check main, SemVer and milestone, then tag and push; VERSION=x.y.z
	@bash "$(ROOT)/scripts/release/release.sh" "$(VERSION)"

release-dry: ## Run release guards without testing, tagging or pushing; requires VERSION
	@bash "$(ROOT)/scripts/release/release.sh" "$(VERSION)" --dry-run

marketplace-release: ## Switch to the archive after latest has the asset; submit the diff in a PR
	@bash "$(ROOT)/scripts/release/ci.sh" activate-marketplace

# install: make the mod load in every session of this config dir, no marketplace.
# Mechanism: the "skills folder". A plugin folder (with .claude-plugin/plugin.json)
# under <config dir>/skills/<name> loads in place as <name>@skills-dir, is never
# copied, and is watched, so edits hot-reload. We add a symlink to the repo folder.
# The config dir follows CLAUDE_CONFIG_DIR, else ~/.claude.
# KB: docs/knowledge-base/claude-code-mods/workflow/develop.md, "4. Skills folder"
# and "Ways to load a mod". The config-dir path is an inference there (open
# question 10). Other options in that page are weaker: dev-mods is per session,
# --plugin-dir is per launch, and CLAUDE_CODE_PLUGIN_DIRS needs a settings.json edit.
# Idempotent: re-running replaces our own link. A real file or folder is never touched.
install: ## Link the mod into the config dir skills folder (idempotent)
	@mkdir -p "$(SKILLS_DIR)"
	@if [ -e "$(LINK)" ] && [ ! -L "$(LINK)" ]; then \
	  echo "Refusing: $(LINK) exists and is not a symlink."; exit 1; fi
	ln -sfn "$(PLUGIN_ABS)" "$(LINK)"
	@echo "Installed: $(LINK) -> $$(readlink "$(LINK)")"
	@echo "Start a new session, or run /reload-plugins. Expect id $(NAME)@skills-dir."

# uninstall: remove the link only when it points at this plugin. Nothing else.
uninstall: ## Remove the link made by install (idempotent)
	@if [ -L "$(LINK)" ]; then \
	  if [ "$$(readlink "$(LINK)")" = "$(PLUGIN_ABS)" ]; then rm "$(LINK)" && echo "Removed: $(LINK)"; \
	  else echo "Skipped: $(LINK) points at $$(readlink "$(LINK)"), not at this plugin."; fi; \
	elif [ -e "$(LINK)" ]; then echo "Skipped: $(LINK) is not a symlink."; \
	else echo "Not installed: $(LINK)"; fi


# clean: generated files only. .claude-plugin/types/ is laid by the engine on a real
# load. Source and tracked files stay.
clean: ## Remove generated files
	rm -rf "$(PLUGIN)/.claude-plugin/types" "$(DIST)"
