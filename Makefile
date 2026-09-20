.DEFAULT_GOAL := help
.PHONY: help start stop restart status logs

help: ## Show local development commands
	@awk 'BEGIN {FS = ":.*## "} /^[a-z-]+:.*## / {printf "  make %-10s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

start: ## Start GenOffice and required Font Lab / Image Lab APIs in the background
	@node tools/dev-services.mjs start

stop: ## Stop only processes started by this entry point
	@node tools/dev-services.mjs stop

restart: ## Stop and start the managed development services
	@node tools/dev-services.mjs restart

status: ## Show process ownership, readiness and log locations
	@node tools/dev-services.mjs status

logs: ## Show the last 40 lines of each managed service log
	@node tools/dev-services.mjs logs
