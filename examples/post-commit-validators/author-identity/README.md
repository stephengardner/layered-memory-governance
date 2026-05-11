# AuthorIdentityValidator (reference adapter)

A reference `PostCommitValidator` that rejects commits whose author
email is not in a configured allow-list of suffixes.

## Why

Every autonomous-flow commit MUST attribute to a bot identity
(lag-ceo / lag-cto / lag-pr-landing / a machine user). A drafter
session that picked up the operator's personal git config would
stamp the commit with the operator's email; the post-commit gate
catches that case locally before the PR opens.

## Indie path

```ts
import { AuthorIdentityValidator } from './author-identity/index.js';
const validators = [
  new AuthorIdentityValidator({
    allowedEmailSuffixes: [
      '@users.noreply.github.com',
      '@noreply.github.com',
    ],
  }),
];
```

## Severity

Critical. An operator-attributed commit reaching this stage is a
hard discipline failure that must abort the dispatch.

## Case insensitivity

Email comparisons normalize both sides to lowercase before
suffix-match. Per RFC 5321 the local part is technically
case-sensitive, but no widely-deployed system relies on that;
GitHub's noreply addresses are lowercase.

## Empty allow-list policy

An empty `allowedEmailSuffixes` rejects every commit. The substrate
ships no implicit allow-list because the right shape is
deployment-specific (which noreply domains, which machine users).
Empty-string entries (`''`) are silently filtered out at
construction time so an accidental blank line in the config does
not flip the gate into allow-all -- which is what
`email.endsWith('')` would otherwise produce. A deployment that
genuinely wants allow-all behaviour ships its own validator
rather than passing an empty suffix.
