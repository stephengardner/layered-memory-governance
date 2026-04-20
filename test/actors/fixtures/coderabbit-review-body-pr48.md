**Actionable comments posted: 2**

<details>
<summary>🧹 Nitpick comments (3)</summary><blockquote>

<details>
<summary>docs/bot-identities.md (1)</summary><blockquote>

`3-3`: **Minor wording: intro lists "merges" as a bot-attributed action, but L58 forbids it.**

L3 reads as a capability list (anything an App *could* be attributed for) while L58 declares merge operator-only under `pol-cto-no-merge`. Not wrong, but a new operator reading top-down will hit the apparent contradiction. Suggest dropping "merges" from the intro sentence or appending "(subject to role policy; see table below)".

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@docs/bot-identities.md` at line 3, The intro sentence that lists
bot-attributed actions currently includes "merges", which conflicts with the
role policy `pol-cto-no-merge`; update the opening line in
docs/bot-identities.md so it either removes "merges" from the capability list or
appends a parenthetical qualifier such as "(subject to role policy; see table
below)" next to `<role>[bot]`, and ensure the wording clearly points readers to
the `pol-cto-no-merge` entry in the policy table.
```

</details>

</blockquote></details>
<details>
<summary>scripts/gh-as.mjs (1)</summary><blockquote>

`58-62`: **Mint failure surfaces as an unhandled rejection.**

Unlike `scripts/gh-token-for.mjs:59-71` which wraps `fetchInstallationToken` in try/catch and prints a `[gh-token-for] token mint failed: ...` line, here a 401/404/network error from GitHub will dump a raw stack and exit 1 via Node's unhandled-rejection path. Worth matching the sibling script's error shape so operators see one consistent `[gh-as] ...` line.

<details>
<summary>♻️ Proposed fix</summary>

```diff
-  const token = await fetchInstallationToken({
-    appId: loaded.record.appId,
-    privateKey: loaded.privateKey,
-    installationId: loaded.record.installationId,
-  });
+  let token;
+  try {
+    token = await fetchInstallationToken({
+      appId: loaded.record.appId,
+      privateKey: loaded.privateKey,
+      installationId: loaded.record.installationId,
+    });
+  } catch (err) {
+    console.error(`[gh-as] token mint failed: ${err?.message ?? err}`);
+    process.exit(1);
+  }
```

</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@scripts/gh-as.mjs` around lines 58 - 62, Wrap the call to
fetchInstallationToken in a try/catch so mint failures are handled the same way
as scripts/gh-token-for.mjs: catch any error thrown by fetchInstallationToken({
appId: loaded.record.appId, privateKey: loaded.privateKey, installationId:
loaded.record.installationId }) and log a single consistent message prefixed
with "[gh-as] token mint failed: " (including the error message/stack), then
exit with process.exit(1); ensure you reference the exact call site in
scripts/gh-as.mjs when adding the try/catch.
```

</details>

</blockquote></details>
<details>
<summary>scripts/gh-token-for.mjs (1)</summary><blockquote>

`65-71`: **Minor: `store.load()` errors bypass the friendly error path.**

The `try/catch` at L59-71 only covers `fetchInstallationToken`. A malformed `.lag/apps/<role>.json`, a missing PEM, or an `assertSafeRole` throw from `createCredentialsStore` (see `src/actors/provisioning/credentials-store.ts:20-31`) will surface as an unhandled promise rejection with a V8 stack trace on stderr — not the `[gh-token-for] ...` prefixed one-liner the rest of the script uses. Cheap to widen the `try` to cover `store.load(role)` too so the error surface is uniform.

<details>
<summary>♻️ Proposed fix</summary>

```diff
-  const store = createCredentialsStore(STATE_DIR);
-  const loaded = await store.load(role);
+  const store = createCredentialsStore(STATE_DIR);
+  let loaded;
+  try {
+    loaded = await store.load(role);
+  } catch (err) {
+    console.error(`[gh-token-for] failed to load credentials for '${role}': ${err?.message ?? err}`);
+    process.exit(1);
+  }
```

</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@scripts/gh-token-for.mjs` around lines 65 - 71, The current try/catch only
wraps fetchInstallationToken so errors from store.load(role) (from
createCredentialsStore / assertSafeRole) escape; expand the error handling to
include the call to store.load(role) by moving the store.load(role) invocation
inside the same try that calls fetchInstallationToken (or add a small try/catch
around store.load(role)) so any errors from
createCredentialsStore/store.load(role) are caught and logged using the same
console.error(`[gh-token-for] ...`) and process.exit(1) path as the
fetchInstallationToken failures.
```

</details>

</blockquote></details>

</blockquote></details>

<details>
<summary>🤖 Prompt for all review comments with AI agents</summary>

```
Verify each finding against the current code and only fix it if needed.

Inline comments:
In `@scripts/gh-as.mjs`:
- Around line 66-76: The spawn call that creates "child" using spawn('gh',
ghArgs, { ..., shell: false }) assumes an actual gh.exe on PATH and fails for
.cmd/.bat shims on Windows; update the code around the spawn usage to detect
process.platform === 'win32' and set shell: true in the options only on Windows
(or alternatively document the gh.exe requirement), ensuring the
GH_TOKEN/GITHUB_TOKEN env injection and stdio: 'inherit' remain unchanged;
reference the spawn invocation, the child variable, ghArgs, and token.token when
locating where to change the shell option.
- Around line 78-80: The current child.on('exit', (code) => process.exit(code ??
0)) masks signal-terminated failures because when a process is killed code is
null and signal is non-null; update the exit handler on the spawned child (the
child.on('exit', ...) callback) to accept both (code, signal), and if signal is
non-null exit with a non-zero value (e.g., process.exit(1) or 128 + signalNumber
if you map signals) otherwise use the numeric exit code (process.exit(code ??
0)); this preserves signal semantics and prevents CI from treating killed
children as successful.

---

Nitpick comments:
In `@docs/bot-identities.md`:
- Line 3: The intro sentence that lists bot-attributed actions currently
includes "merges", which conflicts with the role policy `pol-cto-no-merge`;
update the opening line in docs/bot-identities.md so it either removes "merges"
from the capability list or appends a parenthetical qualifier such as "(subject
to role policy; see table below)" next to `<role>[bot]`, and ensure the wording
clearly points readers to the `pol-cto-no-merge` entry in the policy table.

In `@scripts/gh-as.mjs`:
- Around line 58-62: Wrap the call to fetchInstallationToken in a try/catch so
mint failures are handled the same way as scripts/gh-token-for.mjs: catch any
error thrown by fetchInstallationToken({ appId: loaded.record.appId, privateKey:
loaded.privateKey, installationId: loaded.record.installationId }) and log a
single consistent message prefixed with "[gh-as] token mint failed: " (including
the error message/stack), then exit with process.exit(1); ensure you reference
the exact call site in scripts/gh-as.mjs when adding the try/catch.

In `@scripts/gh-token-for.mjs`:
- Around line 65-71: The current try/catch only wraps fetchInstallationToken so
errors from store.load(role) (from createCredentialsStore / assertSafeRole)
escape; expand the error handling to include the call to store.load(role) by
moving the store.load(role) invocation inside the same try that calls
fetchInstallationToken (or add a small try/catch around store.load(role)) so any
errors from createCredentialsStore/store.load(role) are caught and logged using
the same console.error(`[gh-token-for] ...`) and process.exit(1) path as the
fetchInstallationToken failures.
```

</details>

<details>
<summary>🪄 Autofix (Beta)</summary>

Fix all unresolved CodeRabbit comments on this PR:

- [ ] <!-- {"checkboxId": "4b0d0e0a-96d7-4f10-b296-3a18ea78f0b9"} --> Push a commit to this branch (recommended)
- [ ] <!-- {"checkboxId": "ff5b1114-7d8c-49e6-8ac1-43f82af23a33"} --> Create a new PR with the fixes

</details>

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: Path: .coderabbit.yaml

**Review profile**: CHILL

**Plan**: Pro

**Run ID**: `14b195cf-9eaf-4671-a63c-d7144802e9ce`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 7e811da29d451f6df8c92521bbba7cf8550637a6 and b149fc7377d046a8c82bc1302bdf44c8b11f5cf0.

</details>

<details>
<summary>📒 Files selected for processing (4)</summary>

* `docs/bot-identities.md`
* `roles.json`
* `scripts/gh-as.mjs`
* `scripts/gh-token-for.mjs`

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
