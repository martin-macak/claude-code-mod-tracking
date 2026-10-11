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
# Release version. Read from plugin.json. The release tag is $(NAME)--v$(VERSION).
VERSION := $(shell sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' $(PLUGIN)/.claude-plugin/plugin.json 2>/dev/null | head -n 1)

# Release artifacts. `dist` writes them, the release workflow uploads them.
DIST := $(ROOT)/dist
ZIP  := $(DIST)/$(NAME)-$(VERSION).zip

# Config dir of Claude Code. Same rule as the CLI: $CLAUDE_CONFIG_DIR, else ~/.claude.
CLAUDE_CONFIG_DIR ?= $(HOME)/.claude
SKILLS_DIR := $(CLAUDE_CONFIG_DIR)/skills
LINK       := $(SKILLS_DIR)/$(NAME)

# Project scope: <repo>/.claude/skills/<name>, see install-local.
LOCAL_DIR    := $(ROOT)/.claude/skills
LOCAL_LINK   := $(LOCAL_DIR)/$(NAME)
EXCLUDE_LINE := /.claude/skills/$(NAME)

# TypeScript runner. Override it where mise is absent, for example in CI:
#   make test TSC="npx -y -p typescript@7.0.2 tsc"
TSC ?= mise exec $(NODE) -- npx -y -p typescript tsc

# Node runner for the e2e harness. Override it where mise is absent, for example in CI:
#   make e2e-unit NODE_RUN=
NODE_RUN ?= mise exec $(NODE) --

# e2e harness: Gherkin scenarios that drive a real claude in tmux. Spec:
# docs/superpowers/specs/2026-10-11-demo-pipeline-design.md
E2E       := e2e
E2E_STAMP := $(E2E)/node_modules/.package-lock.json
DEMO_GIF  := docs/assets/demo.gif

.DEFAULT_GOAL := help
.PHONY: help init build typecheck test check e2e-deps e2e-unit e2e demo lint hooks dist release release-dry install uninstall install-local uninstall-local clean

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
	else echo 'mise     : MISSING (required)'; ok=0; fi; \
	for t in gh acli; do \
	  if command -v $$t >/dev/null 2>&1; then printf '%-9s: present (optional)\n' "$$t"; \
	  else printf '%-9s: missing (optional, the mod still works)\n' "$$t"; fi; \
	done; \
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

typecheck: e2e-deps ## Type-check the plugin and the e2e harness with tsc (no claude needed)
	cd $(PLUGIN) && $(TSC) -p .
	cd $(E2E) && $(TSC) -p .

# The suite takes about 3 s, so test depends on build.
test: build ## Run the plugin tests (after build)
	cd $(PLUGIN) && claude plugin test .

check: test ## Alias of test (validate, type-check, test)

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

hooks: ## Install the pre-commit and commit-msg git hooks
	pre-commit install --install-hooks

# dist: the release zip and its checksum, built from the committed tree at HEAD.
# The zip holds one folder, $(NAME)/, with the plugin. `claude --plugin-dir <zip>`
# and `claude --plugin-url <url>` load it. Uncommitted edits are not in the zip.
# KB: docs/knowledge-base/claude-code-mods/workflow/release.md.
dist: ## Build dist/<name>-<version>.zip and dist/SHA256SUMS from HEAD
	@[ -n "$(VERSION)" ] || { echo 'dist failed: no "version" in plugin.json.'; exit 1; }
	@[ -z "$$(git -C "$(ROOT)" status --porcelain -- "$(PLUGIN)")" ] || \
	  echo "Warning: $(PLUGIN) has uncommitted changes. The zip holds HEAD only."
	@rm -rf "$(DIST)" && mkdir -p "$(DIST)"
	git -C "$(ROOT)" archive --format=zip --prefix="$(NAME)/" -o "$(ZIP)" "HEAD:$(PLUGIN)"
	@cd "$(DIST)" && if command -v sha256sum >/dev/null 2>&1; then sha256sum -- *.zip; \
	  else shasum -a 256 -- *.zip; fi > SHA256SUMS
	@cat "$(DIST)/SHA256SUMS"

# release: tag the version in plugin.json and push the tag. The tag push runs
# .github/workflows/release.yml, which tests, builds and publishes the release.
# Flow: bump "version" in plugin.json in a PR, merge it, then run this on main.
# `claude plugin tag` names the tag $(NAME)--v$(VERSION), checks that plugin.json
# and the marketplace entry agree, and refuses a tag that exists.
release: ## Tag plugin.json's version on main and push it (starts the release)
	@[ "$$(git -C "$(ROOT)" rev-parse --abbrev-ref HEAD)" = main ] || \
	  { echo 'Refusing: release runs on main only.'; exit 1; }
	@[ -z "$$(git -C "$(ROOT)" status --porcelain)" ] || \
	  { echo 'Refusing: the working tree has changes.'; exit 1; }
	git -C "$(ROOT)" fetch --quiet origin main
	@[ "$$(git -C "$(ROOT)" rev-parse HEAD)" = "$$(git -C "$(ROOT)" rev-parse origin/main)" ] || \
	  { echo 'Refusing: HEAD is not origin/main. Pull or push first.'; exit 1; }
	@$(MAKE) --no-print-directory test
	cd $(PLUGIN) && claude plugin tag --push

release-dry: ## Show the tag that release would create
	cd $(PLUGIN) && claude plugin tag --dry-run

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

# install-local: load the mod only when Claude Code starts in THIS repo. The user
# config dir is not touched.
# Mechanism: a project-scope skills-directory plugin. A plugin folder under
# <repo>/.claude/skills/<name> loads as <name>@skills-dir, only from the
# .claude/skills/ of the session's primary working directory, so start claude at the
# repo root (a subfolder does not load it). Claude Code asks the workspace trust
# question first, and `-p` never counts as trust.
# KB: docs/knowledge-base/claude-code-mods/workflow/develop.md, "4. Skills folder";
# sources/code-claude-com-2026-10-09/plugins/loading.md, "Plugins shared through a
# repository" (line 73). Rejected: CLAUDE_CODE_PLUGIN_DIRS cannot be set in project or
# local settings (plugins/create.md line 223). enabledPlugins in settings.local.json
# needs a marketplace entry, so it is not used.
# The link is not tracked: its path goes into the repo's .git/info/exclude (local,
# never committed). Idempotent. uninstall-local removes only our link and our line.
install-local: ## Link the mod into <repo>/.claude/skills (this repo only)
	@mkdir -p "$(LOCAL_DIR)"
	@if [ -e "$(LOCAL_LINK)" ] && [ ! -L "$(LOCAL_LINK)" ]; then \
	  echo "Refusing: $(LOCAL_LINK) exists and is not a symlink."; exit 1; fi
	ln -sfn "$(PLUGIN_ABS)" "$(LOCAL_LINK)"
	@ex="$$(git -C "$(ROOT)" rev-parse --path-format=absolute --git-path info/exclude 2>/dev/null)"; \
	if [ -n "$$ex" ]; then \
	  mkdir -p "$$(dirname "$$ex")"; touch "$$ex"; \
	  grep -qxF '$(EXCLUDE_LINE)' "$$ex" || echo '$(EXCLUDE_LINE)' >> "$$ex"; \
	  echo "Excluded from git in $$ex"; \
	else echo 'Not a git repo: no exclude line added.'; fi
	@echo "Installed: $(LOCAL_LINK) -> $$(readlink "$(LOCAL_LINK)")"
	@echo "Start claude at $(ROOT), accept the trust prompt, or run /reload-plugins."

uninstall-local: ## Remove the project link made by install-local (idempotent)
	@if [ -L "$(LOCAL_LINK)" ]; then \
	  if [ "$$(readlink "$(LOCAL_LINK)")" = "$(PLUGIN_ABS)" ]; then rm "$(LOCAL_LINK)" && echo "Removed: $(LOCAL_LINK)"; \
	  else echo "Skipped: $(LOCAL_LINK) points at $$(readlink "$(LOCAL_LINK)"), not at this plugin."; fi; \
	elif [ -e "$(LOCAL_LINK)" ]; then echo "Skipped: $(LOCAL_LINK) is not a symlink."; \
	else echo "Not installed: $(LOCAL_LINK)"; fi
	@ex="$$(git -C "$(ROOT)" rev-parse --path-format=absolute --git-path info/exclude 2>/dev/null)"; \
	if [ -n "$$ex" ] && [ -f "$$ex" ] && grep -qxF '$(EXCLUDE_LINE)' "$$ex"; then \
	  grep -vxF '$(EXCLUDE_LINE)' "$$ex" > "$$ex.tmp"; cat "$$ex.tmp" > "$$ex"; rm -f "$$ex.tmp"; \
	  echo "Removed exclude line from $$ex"; fi

# clean: generated files only. .claude-plugin/types/ is laid by the engine on a real
# load. Source and tracked files stay.
clean: ## Remove generated files
	rm -rf "$(PLUGIN)/.claude-plugin/types" "$(DIST)"
