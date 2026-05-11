# ConventionalCommitTitleValidator (reference adapter)

A reference `PostCommitValidator` that rejects commits whose subject
does not match Conventional Commits.

## Pattern

```regex
^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z][a-z0-9-]*\))?: [a-z]
```

Plus length cap (72 chars) and no-trailing-period.

## Why a post-commit gate

PR-side reviewers catch title regressions only after the PR opens
and a CR cycle runs. A post-commit gate catches them locally so the
executor can amend before the PR creation step. The audit chain that
release-notes generators key off the title shape stays intact.

## Indie path

```ts
import { ConventionalCommitTitleValidator } from './conventional-commit-title/index.js';
const validators = [new ConventionalCommitTitleValidator()];
```

## Test override

The default reader shells `git log -1 --format=%s <sha>` in
`repoDir`. Tests inject a stub via the `readSubject` option.

## Severity

Major. A non-conforming title is fixable by a `git commit --amend`
without redoing the diff; we surface it as a warning audit atom
rather than abort the dispatch.
