# TargetPathsValidator (reference adapter)

A reference `PostCommitValidator` that refuses any commit touching
files not declared on the plan's `target_paths`. The post-commit
blast-radius gate.

## Why a post-commit gate when the planning pipeline already
filters target_paths

The plan-stage's blast-radius fence binds the plan, not the executor.
An agentic agent loop with broader filesystem tools can edit paths
the plan never authorized; a drafter retry on a self-correction
prompt can shift hunks onto neighbouring files. This validator
fires `critical` AT the post-commit boundary so a wandered commit
never opens a PR.

## Indie path

```ts
import { TargetPathsValidator } from './target-paths/index.js';
const validators = [new TargetPathsValidator()];
```

## Severity

Critical. The plan IS the scope; a commit outside scope is a fence
breach.

## What this adapter does NOT cover

- Glob-pattern matching of paths. The substrate ships exact-string
  semantics; an operator that wants glob support builds a wrapper.
- Path normalization (POSIX vs Windows separators, leading `./`,
  trailing slash). The upstream pipeline normalizes; this validator
  does an exact compare on the bytes it receives.
- Case-insensitive comparison. Filesystem case-insensitivity is the
  filesystem's concern; the substrate treats paths as opaque
  byte-strings.
