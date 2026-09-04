.DEFAULT_GOAL := help
.PHONY: help up down logs ps psql install dev build typecheck lint format test venv verify clean

PY := ./.venv/bin/python

help:  ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

up:  ## Start the data plane (db, valkey, minio, mediamtx) and wait for healthy
	docker compose up -d --wait db valkey minio mediamtx

down:  ## Stop the data plane, keep volumes
	docker compose down

ps:  ## Show container health
	docker compose ps

logs:  ## Tail all container logs
	docker compose logs -f --tail=100

psql:  ## Open a psql shell against the local database
	set -a; . ./.env; set +a; psql "$$DATABASE_URL"

install:  ## Install Node workspaces and Python worker deps
	npm install
	$(PY) -m pip install -r workers/requirements.txt

dev:  ## Run API (:4000) and web (:3000)
	npm run dev

build:  ## Build all workspaces
	npm run build

typecheck:  ## TypeScript, strict, all workspaces
	npm run typecheck

lint:  ## ESLint, zero warnings tolerated
	npm run lint

format:  ## Prettier write
	npm run format

test:  ## Vitest
	npm run test

venv:  ## Report the Python interpreter and key CV package versions
	$(PY) -V
	$(PY) -c "import cv2, ultralytics; print('opencv', cv2.__version__, '· ultralytics', ultralytics.__version__)"

verify: typecheck lint test  ## The pre-commit loop
	@echo "verify ok"

clean:  ## Remove build output (keeps node_modules and volumes)
	rm -rf packages/*/dist packages/web/.next
