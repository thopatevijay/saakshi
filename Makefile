.DEFAULT_GOAL := help
.PHONY: help up down logs ps psql migrate rollback db-reset db-status install dev build \
        typecheck lint format test venv venv-create verify clean models

PY := ./.venv/bin/python
# python3.13 by name, not `python3`: Homebrew's default is 3.14 + PEP 668 and has no reliable
# OpenCV wheels. See README "Python workers".
PY_BOOTSTRAP := python3.13

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

migrate:  ## Apply pending migrations (idempotent)
	set -a; . ./.env; set +a; npm run db:migrate

rollback:  ## Revert the newest applied migration (ROLLBACK_ALL=1 for every one)
	set -a; . ./.env; set +a; npm run db:rollback $(if $(ROLLBACK_ALL),-- --all,)

db-reset:  ## Drop and recreate the public schema, then migrate. DESTROYS ALL DATA
	set -a; . ./.env; set +a; npm run db:reset

db-status:  ## List applied vs pending migrations
	set -a; . ./.env; set +a; npm run db:status

venv-create:  ## Create .venv on python3.13 if it is missing
	@test -x $(PY) || { \
	  command -v $(PY_BOOTSTRAP) >/dev/null || { echo "$(PY_BOOTSTRAP) not found — brew install python@3.13"; exit 1; }; \
	  $(PY_BOOTSTRAP) -m venv .venv && $(PY) -m pip install --quiet --upgrade pip; \
	  echo "created .venv on $$($(PY) -V)"; }

install: venv-create  ## Install Node workspaces and Python worker deps
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

models:  ## Fetch the YOLO11 detector weights into models/ (gitignored, never committed)
	@mkdir -p models
	@test -f models/yolo11n.pt || $(PY) -c "from ultralytics import YOLO; import shutil; \
	  p = YOLO('yolo11n.pt').ckpt_path; shutil.copy(p, 'models/yolo11n.pt'); print('fetched', p)"
	@ls -la models/yolo11n.pt

venv:  ## Report the Python interpreter and key CV package versions
	$(PY) -V
	$(PY) -c "import cv2, ultralytics; print('opencv', cv2.__version__, '· ultralytics', ultralytics.__version__)"

verify: typecheck lint test  ## The pre-commit loop
	@echo "verify ok"

clean:  ## Remove build output (keeps node_modules and volumes)
	rm -rf packages/*/dist packages/web/.next
