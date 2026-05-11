import { describe, it, expect } from 'vitest';
import {
  buildGitNoPromptEnv,
  withGitNoPromptEnv,
} from '../../scripts/lib/git-spawn-no-prompt.mjs';

describe('buildGitNoPromptEnv', () => {
  it('sets GIT_TERMINAL_PROMPT=0 to disable git own prompt', () => {
    const env = buildGitNoPromptEnv();
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('clears GIT_ASKPASS and SSH_ASKPASS so inherited GUI shims do not fire', () => {
    const env = buildGitNoPromptEnv();
    expect(env.GIT_ASKPASS).toBe('');
    expect(env.SSH_ASKPASS).toBe('');
  });

  it('wipes credential.helper via GIT_CONFIG_* override pair', () => {
    const env = buildGitNoPromptEnv();
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
  });

  it('returns a fresh object each call', () => {
    expect(buildGitNoPromptEnv()).not.toBe(buildGitNoPromptEnv());
  });
});

describe('withGitNoPromptEnv', () => {
  it('preserves caller env keys that do not collide with the safety set', () => {
    const out = withGitNoPromptEnv({ PATH: '/usr/bin', MY_TOKEN: 'abc' });
    expect(out.PATH).toBe('/usr/bin');
    expect(out.MY_TOKEN).toBe('abc');
  });

  it('forces the prompt-neutralization set to win over caller-passed conflicts', () => {
    // If a caller's parent env somehow already had GIT_ASKPASS pointed
    // at a GUI shim, the helper MUST overwrite it. The invariant: a
    // script that uses this helper cannot have the popup re-enabled
    // by an inherited parent env.
    const out = withGitNoPromptEnv({
      GIT_TERMINAL_PROMPT: '1',
      GIT_ASKPASS: 'C:/some/gui-helper.exe',
      SSH_ASKPASS: '/usr/bin/something',
    });
    expect(out.GIT_TERMINAL_PROMPT).toBe('0');
    expect(out.GIT_ASKPASS).toBe('');
    expect(out.SSH_ASKPASS).toBe('');
  });

  it('forces credential.helper override even if caller had a different GIT_CONFIG layout', () => {
    const out = withGitNoPromptEnv({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: 'Authorization: Bearer xyz',
    });
    expect(out.GIT_CONFIG_COUNT).toBe('1');
    expect(out.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(out.GIT_CONFIG_VALUE_0).toBe('');
  });

  it('handles a null / undefined existingEnv gracefully', () => {
    expect(withGitNoPromptEnv(undefined).GIT_TERMINAL_PROMPT).toBe('0');
    expect(withGitNoPromptEnv(null as unknown as undefined).GIT_TERMINAL_PROMPT).toBe('0');
  });
});
