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
