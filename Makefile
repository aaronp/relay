# Local SpacetimeDB listens where the CLI's `local` server entry points (port 3000 is often taken).
LISTEN ?= 127.0.0.1:3010
SERVER ?= local
DB     ?= topics
UI_PORT ?= 5173
# Where `make deploy` publishes.
DEPLOY_SERVER ?= maincloud
DEPLOY_DB     ?= topics

.PHONY: dev stop dev-status build ui auth-off auth-on deploy

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
	@if spacetime sql -s $(SERVER) $(DB) "SELECT disabled FROM auth_mode" 2>/dev/null | grep -q true; then \
		echo "  AUTH DISABLED — run: make auth-on"; \
	fi
	@spacetime server ping $(SERVER) >/dev/null 2>&1

## Build the standalone `chat` binary into dist/chat.
build:
	bun build cli/src/main.ts --compile --outfile dist/chat

## Start the web reference UI at http://127.0.0.1:5173 (fixed origin = kerits client_id).
ui:
	bun run --cwd web dev

## Dev only: turn every auth check off for $(DB) on $(SERVER) (anyone can create, send and read; no token needed).
auth-off:
	spacetime call -s $(SERVER) $(DB) set_auth_disabled true

## Turn auth back on (drops all sessions; clients reconnect with a token).
auth-on:
	spacetime call -s $(SERVER) $(DB) set_auth_disabled false

## Publish the module to $(DEPLOY_DB) on $(DEPLOY_SERVER) (needs `spacetime login`). Keeps data; refuses
## migrations that would delete it. A first deploy also needs set_config (see README).
deploy:
	spacetime publish -s $(DEPLOY_SERVER) $(DEPLOY_DB) --module-path module -y
