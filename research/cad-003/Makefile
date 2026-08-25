.PHONY: test bench clean

# Deterministic correctness gate (what CI runs):
# executes the full benchmark in-process and asserts zero failures
# and zero unknowns.
test:
	python3 -m pytest tests/ -q

# Produce the full evidence package under evidence/<run-id>/.
bench:
	python3 -m offisos_ifcbench.benchmarks.run_all $${RUN_ID:-run-001}

clean:
	rm -rf evidence/ci-run
