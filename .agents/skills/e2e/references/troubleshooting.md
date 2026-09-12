# E2E Failure Diagnosis

Reproduce the affected case with `./scripts/run-e2e.sh -p 1 -k "test_name" -x`. For failures seen only in parallel, compare that result with the original parallel invocation and verify the fix under the failing mode.

| Symptom | Inspect |
| --- | --- |
| Binary missing or behavior inconsistent with the change | Rebuild `build/rtp2httpd`; collection alone does not exercise it |
| Import, discovery, or marker errors | `helpers/__init__.py`, `pyproject.toml`, and one `--co` run |
| Bind/startup failure | `R2HProcess.start()` error and captured logs; allocation through `helpers/ports.py`; occupied ports and fixture teardown |
| Parallel-only failures | Fixture scope, mutable mock request logs, worker port ranges, shared files |
| Hanging stream or multicast read | Whether media is produced, mock startup order, interface/multicast availability, and the read length/timeout |
| Missing external M3U immediately after startup | Fetching `-M http://...` or `-M file://...` is asynchronous; wait for the expected condition with a bounded timeout |
| Slow suite tail | Large classes/modules holding one loadscope worker; split by functional area without breaking fixture isolation |

Do not treat a skipped platform capability as tested coverage. Record environment blockers, and avoid increasing timeouts or disabling parallelism as a substitute for diagnosing shared-state failures.
