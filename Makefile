# Local SpacetimeDB listens where the CLI's `local` server entry points (port 3000 is often taken).
LISTEN ?= 127.0.0.1:3010
SERVER ?= local
DB     ?= topics
UI_PORT ?= 5173

.PHONY: dev stop dev-status build ui

## Start SpacetimeDB locally (foreground; Ctrl-C to stop).
dev:
	spacetime start --listen-addr $(LISTEN)

## Stop local SpacetimeDB (port $(LISTEN)) and the web UI (port $(UI_PORT)) if they're running.
stop:
	@for port in $(lastword $(subst :, ,$(LISTEN))) $(UI_PORT); do \
		pids=$$(lsof -ti tcp:$$port -sTCP:LISTEN); \
		if [ -n "$$pids" ]; then kill $$pids && echo "stopped port $$port (pid $$pids)"; \
		else echo "nothing listening on port $$port"; fi; \
	done

## Report whether local SpacetimeDB is up and whether the $(DB) database is published.
dev-status:
	@echo "server ($(SERVER) @ $(LISTEN)):"
	@spacetime server ping $(SERVER) 2>&1 | tail -1 | sed 's/^/  /'
	@echo "database $(DB):"
	@if spacetime describe -s $(SERVER) $(DB) --json >/dev/null 2>&1; then \
		echo "  published"; \
	else \
		echo "  not published — run: spacetime publish -s $(SERVER) $(DB) --module-path module -y"; \
	fi
	@spacetime server ping $(SERVER) >/dev/null 2>&1

## Build the standalone `chat` binary into dist/chat.
build:
	bun build cli/src/main.ts --compile --outfile dist/chat

## Start the web reference UI at http://127.0.0.1:5173 (fixed origin = kerits client_id).
ui:
	bun run --cwd web dev
