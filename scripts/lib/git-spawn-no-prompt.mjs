// Pure helpers for spawning `git` from Node scripts in a way that never
// triggers a Windows Git Credential Manager popup. Spawning `git` with
// the parent process's inherited env will, on a Cursor-managed Windows
// host, route through GCM whenever a network op (`fetch`, `ls-remote`,
// `push`, `clone`) needs auth and nothing matches the requested remote
// in the cache. GCM shows a GUI dialog asking the user to sign in --
// blocking the script silently with no TTY signal back to the script.
//
// Mirrors the env shape that scripts/lib/git-as-push-auth.mjs produces
// (buildReadOnlyEnv / buildPushEnv), without the token: this helper is
// for read-only ops where a cached token is acceptable BUT a credential
// helper popup must never fire. Callers that need bot-authenticated
// pushes still route through scripts/git-as.mjs; this helper is the
// substrate floor for the `execa('git', ...)` calls that are NOT
// supposed to negotiate fresh credentials.

/**
 * Produce the child-env overrides for safe `git` spawns.
 *
 *   GIT_TERMINAL_PROMPT=0   git's own prompt path. Off when set to '0'.
 *   GIT_ASKPASS=''           on Windows, git first consults the askpass
 *                            helper (often a GUI shim). Empty string
 *                            disables it explicitly; without this the
 *                            shim hangs ~30s waiting for input that
 *                            never arrives.
 *   SSH_ASKPASS=''           same shape for SSH transports.
 *   GIT_CONFIG_COUNT=1       in-process credential.helper override --
 *   GIT_CONFIG_KEY_0         the cached PAT in GCM is the most common
 *   GIT_CONFIG_VALUE_0       Windows source of unintended prompts.
 *                            Clearing it for the spawn makes git skip
 *                            the helper entirely and either succeed
 *                            (the remote is public or no auth needed)
 *                            or fail fast (auth required, none cached).
 *
 * Exclusive ownership of GIT_CONFIG_*
 * -----------------------------------
 * This helper assumes exclusive ownership of the GIT_CONFIG_* slot-0
 * namespace. Composing it with callers that inject their own
 * GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n> via the existingEnv
 * argument is NOT supported: withGitNoPromptEnv() unconditionally
 * resets COUNT='1' and writes credential.helper='' into slot 0,
 * overwriting whatever the caller staged there. If you need to layer
 * a token via `http.extraHeader` AND neutralize the credential
 * helper (the buildReadOnlyEnv shape in scripts/lib/git-as-push-auth.mjs
 * is the canonical example), do it directly in that helper -- do
 * not stack it on top of withGitNoPromptEnv(). The two paths are
 * mutually exclusive by design: git-as.mjs handles bot-authenticated
 * read/push; this helper handles fail-fast for non-authenticated
 * spawns.
 */
export function buildGitNoPromptEnv() {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
  };
}

/**
 * Merge buildGitNoPromptEnv() on top of an existing env (typically
 * process.env). Caller-supplied keys win EXCEPT for the prompt /
 * askpass / credential-helper fields, which this helper forces to
 * the safe values regardless of what the parent inherits. The forced
 * shape is the invariant: a script that imports this helper must not
 * be able to accidentally re-enable the popup by passing through a
 * parent env that already had GIT_ASKPASS set.
 *
 * Pure: takes the existing env, returns a new object. No side
 * effects. Tests can drive it without process.env mutation.
 */
export function withGitNoPromptEnv(existingEnv) {
  const base = existingEnv ?? {};
  return {
    ...base,
    ...buildGitNoPromptEnv(),
  };
}
