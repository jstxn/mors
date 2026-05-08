import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPOOL_POLICY,
  mergeSpoolPolicy,
  normalizeSpoolPolicy,
  validateSpoolCommandPolicy,
} from '../../src/spool/policy.js';
import { SPOOL_SCHEMA, type SpoolCommand } from '../../src/spool/types.js';

describe('spool policy', () => {
  it('preserves defaults when sparse overrides omit quota and tool values', () => {
    const policy = mergeSpoolPolicy(DEFAULT_SPOOL_POLICY, {
      quotas: {
        maxEntryBytes: undefined,
        maxPendingEntries: 12,
      },
      tools: {
        allowRequests: undefined,
        maxArgsBytes: undefined,
      },
    });

    expect(policy.quotas.maxEntryBytes).toBe(DEFAULT_SPOOL_POLICY.quotas.maxEntryBytes);
    expect(policy.quotas.maxPendingEntries).toBe(12);
    expect(policy.tools.allowRequests).toBe(false);
    expect(policy.tools.maxArgsBytes).toBe(DEFAULT_SPOOL_POLICY.tools.maxArgsBytes);
  });

  it('normalizes sparse JSON policy files without disabling omitted defaults', () => {
    const policy = normalizeSpoolPolicy({
      schema: 'mors.spool.policy.v1',
      quotas: {
        max_pending_entries: 5,
      },
      tools: {
        allow_requests: true,
        allowed_names: ['run-tests'],
        runners: {
          'run-tests': {
            command: 'node',
            args: ['scripts/run-tests.js'],
            cwd: '/workspace',
            timeout_ms: 120000,
            max_output_bytes: 1024,
          },
        },
      },
    });

    expect(policy.quotas.maxEntryBytes).toBe(DEFAULT_SPOOL_POLICY.quotas.maxEntryBytes);
    expect(policy.quotas.maxPendingEntries).toBe(5);
    expect(policy.tools.allowRequests).toBe(true);
    expect(policy.tools.allowedNames).toEqual(['run-tests']);
    expect(policy.tools.maxArgsBytes).toBe(DEFAULT_SPOOL_POLICY.tools.maxArgsBytes);
    expect(policy.tools.runners?.['run-tests']).toMatchObject({
      command: 'node',
      args: ['scripts/run-tests.js'],
      cwd: '/workspace',
      timeoutMs: 120000,
      maxOutputBytes: 1024,
    });
  });

  it('blocks oversized tool arguments even when tool requests are allowed', () => {
    const command: SpoolCommand = {
      schema: SPOOL_SCHEMA,
      kind: 'tool_request',
      recipient_id: 'acct_host',
      body: { format: 'text/markdown', content: 'run with large args' },
      tool: {
        name: 'run-tests',
        args: { payload: 'x'.repeat(100) },
      },
    };

    const policy = mergeSpoolPolicy(DEFAULT_SPOOL_POLICY, {
      tools: { allowRequests: true, allowedNames: ['run-tests'], maxArgsBytes: 16 },
    });

    expect(() => validateSpoolCommandPolicy(command, policy)).toThrow(/Tool args exceed max size/);
  });
});
