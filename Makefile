.PHONY: install run test typecheck

install:
	./install.sh

run:
	./run.sh

test:
	.venv/bin/python -m pytest -q

# Dev-only type check of the RF engine and planner state (JSDoc and inferred types). Needs network for npx once.
typecheck:
	npx -p typescript tsc -p tsconfig.json
