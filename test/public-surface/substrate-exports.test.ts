import { describe, it, expect } from 'vitest';
import * as substrate from '../../src/substrate/index.js';

describe('public surface: substrate barrel', () => {
  it('exposes new agentic-actor-loop seams', () => {
    expect(substrate.agentLoop).toBeDefined();
    expect(substrate.workspaceProvider).toBeDefined();
    expect(substrate.blobStore).toBeDefined();
    expect(substrate.redactor).toBeDefined();
    expect(substrate.agentBudget).toBeDefined();
    expect(substrate.policyReplayTier).toBeDefined();
    expect(substrate.policyBlobThreshold).toBeDefined();
    expect(substrate.projectionsSessionTree).toBeDefined();
  });

  it('preserves existing exports', () => {
    expect(substrate.deliberation).toBeDefined();
    expect(substrate.arbitration).toBeDefined();
    expect(substrate.canonMd).toBeDefined();
    expect(substrate.killSwitch).toBeDefined();
    expect(substrate.promotion).toBeDefined();
    expect(substrate.taint).toBeDefined();
  });

  it('agent-loop namespace exposes defaultClassifyFailure', () => {
    expect(typeof substrate.agentLoop.defaultClassifyFailure).toBe('function');
  });

  it('blobStore namespace exposes blobRefFromHash + parseBlobRef + BlobRefError', () => {
    expect(typeof substrate.blobStore.blobRefFromHash).toBe('function');
    expect(typeof substrate.blobStore.parseBlobRef).toBe('function');
    expect(typeof substrate.blobStore.BlobRefError).toBe('function');
  });

  it('agentBudget namespace exposes the threshold bounds + helpers', () => {
    expect(substrate.agentBudget.BLOB_THRESHOLD_MIN).toBe(256);
    expect(substrate.agentBudget.BLOB_THRESHOLD_MAX).toBe(1_048_576);
    expect(substrate.agentBudget.BLOB_THRESHOLD_DEFAULT).toBe(4096);
    expect(typeof substrate.agentBudget.clampBlobThreshold).toBe('function');
    expect(typeof substrate.agentBudget.defaultBudgetCap).toBe('function');
  });

  it('policy namespaces expose load* + atomId helpers', () => {
    expect(substrate.policyReplayTier.REPLAY_TIER_DEFAULT).toBe('content-addressed');
    expect(typeof substrate.policyReplayTier.loadReplayTier).toBe('function');
    expect(typeof substrate.policyReplayTier.replayTierAtomId).toBe('function');
    expect(typeof substrate.policyBlobThreshold.loadBlobThreshold).toBe('function');
    expect(typeof substrate.policyBlobThreshold.blobThresholdAtomId).toBe('function');
  });

  it('projectionsSessionTree exposes buildSessionTree + SessionTreeError', () => {
    expect(typeof substrate.projectionsSessionTree.buildSessionTree).toBe('function');
    expect(typeof substrate.projectionsSessionTree.SessionTreeError).toBe('function');
  });
});
