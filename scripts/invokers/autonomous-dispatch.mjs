// scripts/invokers/autonomous-dispatch.mjs
/**
 * Dispatch-invoker registrar for run-approval-cycle --invokers <this-path>.
 * Registers code-author so plans with delegation.sub_actor_principal_id='code-author'
 * dispatch into the existing code-author flow.
 *
 * auditor-actor is registered by run-approval-cycle itself (read-only, always safe);
 * this module only adds code-author.
 *
 * CRITICAL: the wrapper applies `autonomous-intent` and `plan-id:<id>` labels
 * to the PR after code-author's executor opens it. These labels key the
 * pr-landing workflow's LAG-auditor gate. Without them, once the branch-
 * protection migration runs, every intent-driven PR will hang on the
 * never-posted LAG-auditor required status.
 */
import { execa } from 'execa';

export default async function register(host, registry) {
  const { runCodeAuthor } = await import('../../dist/runtime/actor-message/code-author-invoker.js');
  const { buildDefaultCodeAuthorExecutor } = await import('../../dist/runtime/actor-message/code-author-executor-default.js');

  const defaultExecutor = buildDefaultCodeAuthorExecutor({
    remote: process.env.GH_REMOTE ?? 'origin',
    baseBranch: process.env.GH_BASE_BRANCH ?? 'main',
  });

  registry.register('code-author', async (payload, correlationId) => {
    let capturedPrNumber = null;
    let capturedPlanId = null;
    const wrappedExecutor = {
      async execute(inputs) {
        capturedPlanId = String(inputs.plan.id);
        const execResult = await defaultExecutor.execute(inputs);
        if (execResult.kind === 'dispatched') {
          capturedPrNumber = execResult.prNumber;
        }
        return execResult;
      },
    };

    const result = await runCodeAuthor(host, payload, correlationId, { executor: wrappedExecutor });

    if (result.kind === 'dispatched' && capturedPrNumber !== null && capturedPlanId !== null) {
      const plan = await host.atoms.get(capturedPlanId);
      const intentId = plan?.provenance?.derived_from?.find((id) => id.startsWith('intent-'));
      if (intentId) {
        const repo = process.env.GH_REPO ?? 'stephengardner/layered-autonomous-governance';
        try {
          await execa('node', [
            'scripts/gh-as.mjs', 'lag-ceo',
            'api', `repos/${repo}/issues/${capturedPrNumber}/labels`,
            '-X', 'POST',
            '-f', 'labels[]=autonomous-intent',
            '-f', `labels[]=plan-id:${capturedPlanId}`,
          ], { stdio: 'inherit' });
        } catch (err) {
          console.error(`[autonomous-dispatch] WARNING: failed to label PR #${capturedPrNumber}: ${err.message}. LAG-auditor gate will not fire until labels are added manually.`);
        }
      }
    }
    return result;
  });
}
