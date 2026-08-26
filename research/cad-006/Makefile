.PHONY: test bench clean

# Deterministic correctness gate (what CI runs):
# executes the full licensing/composition inventory in-process and asserts
# zero failures. `unknown` results do not fail the run (first-class epistemic
# state) but are counted and visible.
test:
	python3 -m pytest tests/ -q

# Produce the full evidence package under evidence/<run-id>/.
# Run-id defaults to run-001 (the committed reference evidence run).
bench:
	python3 -m offisos_licbench.benchmarks.run_all $${RUN_ID:-run-001}

# Clean generated evidence runs (careful: run-001 is committed evidence).
clean:
	rm -rf evidence/ci-run
