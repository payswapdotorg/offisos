.PHONY: test bench clean

# Deterministic correctness gate (what CI runs):
# executes the full benchmark in-process and asserts zero failures.
test:
	python3 -m pytest tests/ -q

# Produce the full evidence package under evidence/<run-id>/.
# Run-id defaults to run-001 (the committed reference evidence run).
bench:
	python3 -m offisos_cadbench.benchmarks.run_all $${RUN_ID:-run-001}

# Clean generated evidence runs (careful: run-001 is committed evidence).
clean:
	rm -rf evidence/ci-run
