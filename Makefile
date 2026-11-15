.PHONY: install run test

install:
	./install.sh

run:
	./run.sh

test:
	.venv/bin/python -m pytest -q
