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

# Config dir of Claude Code. Same rule as the CLI: $CLAUDE_CONFIG_DIR, else ~/.claude.
CLAUDE_CONFIG_DIR ?= $(HOME)/.claude
SKILLS_DIR := $(CLAUDE_CONFIG_DIR)/skills
LINK       := $(SKILLS_DIR)/$(NAME)

# Project scope: <repo>/.claude/skills/<name>, see install-local.
LOCAL_DIR    := $(ROOT)/.claude/skills
LOCAL_LINK   := $(LOCAL_DIR)/$(NAME)
EXCLUDE_LINE := /.claude/skills/$(NAME)

TSC = mise exec $(NODE) -- npx -y -p typescript tsc

.DEFAULT_GOAL := help
.PHONY: help init build test check install uninstall install-local uninstall-local clean

help: ## List the targets
	@echo "Targets (PLUGIN=$(PLUGIN)):"
	@awk -F':.*## ' '/^[a-z][a-z-]*:.*## /{printf "  %-16s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

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
	[ "$$ok" = 1 ] || { echo 'init failed: a required tool is missing.'; exit 1; }; \
	echo 'Warming the TypeScript npx cache...'; \
	printf 'tsc      : %s\n' "$$($(TSC) --version)"

# Nothing is emitted. Claude Code loads the .ts and .tsx files directly,
# so "build" only validates the plugin and type-checks it.
build: ## Validate the plugin, then type-check (no output files)
	cd $(PLUGIN) && claude plugin validate .
	cd $(PLUGIN) && $(TSC) -p .

# The suite takes about 3 s, so test depends on build.
test: build ## Run the plugin tests (after build)
	cd $(PLUGIN) && claude plugin test .

check: test ## Alias of test (validate, type-check, test)

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
	rm -rf "$(PLUGIN)/.claude-plugin/types"
