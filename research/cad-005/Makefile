.PHONY: test bench clean

# Deterministic correctness gate (what CI runs): small tiers only,
# bounded repeats, no expensive stress points.
test:
	python3 -m pytest tests/ -q

# Produce the full evidence package under evidence/<run-id>/.
# CAD005_REPEATS (default 5) sets per-operation repeats (large tiers use
# half); CAD005_DETERMINISM_REPEATS (default 10) sets the variance-run
# count. Execution is resumable: completed modules persist in .work/
# and are reused on the next invocation (CAD005_FRESH=1 resets).
bench:
	CAD005_FRESH=1 python3 -m offisos_perfbench.benchmarks.run_all $${RUN_ID:-run-001}

clean:
	rm -rf evidence/ci-run .work
