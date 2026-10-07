// Tests that create throwaway repositories must never reach the real one. Git hooks (husky's
// pre-commit runs this suite) export GIT_DIR, GIT_INDEX_FILE and friends, and every git child
// process would inherit them: drop them before any test runs.
for (const key of Object.keys(process.env)) {
  if (
    /^GIT_(DIR|INDEX_FILE|WORK_TREE|COMMON_DIR|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE)$/.test(
      key,
    )
  ) {
    delete process.env[key];
  }
}

// Model ids in tests are placeholders; the real catalogs (~/.codex, `agy models`) must not decide
// whether a job starts. test/models.test.ts turns the check back on with its own catalogs.
process.env["AGENTMATE_SKIP_MODEL_CHECK"] = "1";

// The developer's own Copilot CLI must not count as installed: the availability and default-partner
// tests enumerate agents. test/copilot.test.ts points AGENTMATE_COPILOT_BIN at a fake binary.
process.env["AGENTMATE_COPILOT_BIN"] = "/nonexistent/agentmate-test/copilot";
