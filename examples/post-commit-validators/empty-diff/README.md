# EmptyDiffValidator (reference adapter)

A reference `PostCommitValidator` that rejects empty / no-op commits.
Sits in the agentic + diff-based code-author executors' post-commit
gate (`src/substrate/post-commit-validator.ts`) and fires `critical`
when the commit touched no files OR the diff has no content-changing
`+`/`-` lines.

## Why ship this even though the diff-based executor already
short-circuits empty diffs upstream

The upstream empty-diff guard runs BEFORE `git apply`; it is the
right gate for the LLM-emits-empty-string case. A different executor
(agentic, external workflow, custom adapter) may produce a real
commit whose net effect is no byte changes (e.g. a "touch only"
op, a comment that was already there). The post-commit validator
catches that case at the boundary every executor shares.

## Indie path

```ts
// From a caller in the parent `examples/post-commit-validators/`
// directory or anywhere that has the package's example tree on its
// import path:
import { EmptyDiffValidator } from './empty-diff/index.js';
const validators = [new EmptyDiffValidator()];
```

## Severity

Critical. An empty PR is always a mistake reaching this stage.
