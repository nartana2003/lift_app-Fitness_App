PASS
tsc: clean
lint: 0 errors, 2 pre-existing warnings (lib/social/__tests__/oembed.test.ts, untouched by item)
tests: 1527 total (baseline 1194) -> OK. Full run: 1 failed, generate-routines.qa "deterministic" (8.3s load timeout); passed alone (147/147); waived by coordinator. DataBackup.test.tsx worker-start timeout under load; passed alone with dataExport, splitRoutines, autofill tests (61/61).
new module lib/splitRoutines.ts has lib/__tests__/splitRoutines.test.ts
build: npx next build OK
e2e smoke (E2E_PORT=3113): 3 passed, 4 flaky (setup timeouts under load, passed on retry), 0 failed
