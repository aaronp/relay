# Local SpacetimeDB listens where the CLI's `local` server entry points (port 3000 is often taken).
LISTEN ?= 127.0.0.1:3010
SERVER ?= local
DB     ?= topics

.PHONY: dev dev-status build

## Start SpacetimeDB locally (foreground; Ctrl-C to stop).
dev:
	spacetime start --listen-addr $(LISTEN)

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
