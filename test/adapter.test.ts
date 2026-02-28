/**
 * Adapter contract tests for Phase 2 transport and integration interfaces.
 *
 * These tests verify that:
 * - Adapter interfaces are properly typed and importable
 * - Stub/noop implementations satisfy the contracts
 * - No active remote relay or integration behavior is introduced
 * - Core flows remain unaffected by adapter stub presence
 *
 * Fulfills: phase2-adapter-contract-stubs
 */

import { describe, it, expect } from 'vitest';
import type {
  TransportAdapter,
  TransportEnvelope,
  TransportResult,
  IntegrationAdapter,
  IntegrationEvent,
  AdapterMetadata,
} from '../src/adapters/index.js';
import {
  NoopTransportAdapter,
  NoopIntegrationAdapter,
  ADAPTER_CAPABILITIES,
  INTEGRATION_EVENT_TYPES,
} from '../src/adapters/index.js';
import type { MessageEnvelope } from '../src/contract/index.js';
import { generateMessageId, generateThreadId } from '../src/contract/index.js';

// ── Helpers ────────────────────────────────────────────────────────────

function makeEnvelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  const now = new Date().toISOString();
  return {
    id: generateMessageId(),
    thread_id: generateThreadId(),
    in_reply_to: null,
    sender: 'alice',
    recipient: 'bob',
    subject: null,
    body: 'Hello from adapter test',
    dedupe_key: null,
    trace_id: null,
    state: 'delivered',
    read_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

// ── Transport Adapter Contract ─────────────────────────────────────────

describe('TransportAdapter contract', () => {
  describe('interface shape', () => {
    it('NoopTransportAdapter satisfies TransportAdapter interface', () => {
      const adapter: TransportAdapter = new NoopTransportAdapter();
      expect(adapter).toBeDefined();
      expect(typeof adapter.send).toBe('function');
      expect(typeof adapter.receive).toBe('function');
      expect(typeof adapter.metadata).toBe('function');
    });

    it('metadata returns correct adapter identification', () => {
      const adapter = new NoopTransportAdapter();
      const meta = adapter.metadata();
      expect(meta.name).toBe('noop');
      expect(meta.version).toBe('0.0.0');
      expect(meta.capabilities).toContain('none');
      expect(typeof meta.description).toBe('string');
      expect(meta.description.length).toBeGreaterThan(0);
    });
  });

  describe('noop send behavior', () => {
    it('send resolves without performing remote relay', async () => {
      const adapter = new NoopTransportAdapter();
      const envelope = makeEnvelope();
      const result = await adapter.send(envelope);
      expect(result.delivered).toBe(false);
      expect(result.reason).toBe('noop');
      expect(result.remoteId).toBeNull();
    });

    it('send preserves envelope identity in result', async () => {
      const adapter = new NoopTransportAdapter();
      const envelope = makeEnvelope();
      const result = await adapter.send(envelope);
      expect(result.localId).toBe(envelope.id);
    });

    it('send with different envelopes always returns noop result', async () => {
      const adapter = new NoopTransportAdapter();
      const env1 = makeEnvelope({ body: 'First message' });
      const env2 = makeEnvelope({ body: 'Second message' });
      const [r1, r2] = await Promise.all([adapter.send(env1), adapter.send(env2)]);
      expect(r1.delivered).toBe(false);
      expect(r2.delivered).toBe(false);
      expect(r1.localId).toBe(env1.id);
      expect(r2.localId).toBe(env2.id);
    });
  });

  describe('noop receive behavior', () => {
    it('receive resolves to empty array (no remote messages)', async () => {
      const adapter = new NoopTransportAdapter();
      const messages = await adapter.receive();
      expect(Array.isArray(messages)).toBe(true);
      expect(messages).toHaveLength(0);
    });

    it('receive is idempotent and always returns empty', async () => {
      const adapter = new NoopTransportAdapter();
      const r1 = await adapter.receive();
      const r2 = await adapter.receive();
      expect(r1).toEqual([]);
      expect(r2).toEqual([]);
    });
  });
});

// ── Integration Adapter Contract ───────────────────────────────────────

describe('IntegrationAdapter contract', () => {
  describe('interface shape', () => {
    it('NoopIntegrationAdapter satisfies IntegrationAdapter interface', () => {
      const adapter: IntegrationAdapter = new NoopIntegrationAdapter('github');
      expect(adapter).toBeDefined();
      expect(typeof adapter.poll).toBe('function');
      expect(typeof adapter.transform).toBe('function');
      expect(typeof adapter.metadata).toBe('function');
    });

    it('metadata returns correct adapter identification', () => {
      const adapter = new NoopIntegrationAdapter('github');
      const meta = adapter.metadata();
      expect(meta.name).toBe('github');
      expect(meta.version).toBe('0.0.0');
      expect(meta.capabilities).toContain('none');
      expect(meta.description).toContain('github');
    });
  });

  describe('supports all integration types', () => {
    const types: Array<'github' | 'linear' | 'jira' | 'email'> = [
      'github',
      'linear',
      'jira',
      'email',
    ];

    for (const type of types) {
      it(`creates NoopIntegrationAdapter for ${type}`, () => {
        const adapter = new NoopIntegrationAdapter(type);
        const meta = adapter.metadata();
        expect(meta.name).toBe(type);
      });
    }
  });

  describe('noop poll behavior', () => {
    it('poll resolves to empty array (no external events)', async () => {
      const adapter = new NoopIntegrationAdapter('jira');
      const events = await adapter.poll();
      expect(Array.isArray(events)).toBe(true);
      expect(events).toHaveLength(0);
    });

    it('poll is idempotent and always returns empty', async () => {
      const adapter = new NoopIntegrationAdapter('linear');
      const r1 = await adapter.poll();
      const r2 = await adapter.poll();
      expect(r1).toEqual([]);
      expect(r2).toEqual([]);
    });
  });

  describe('noop transform behavior', () => {
    it('transform returns null for any event (no transformation)', async () => {
      const adapter = new NoopIntegrationAdapter('email');
      const event: IntegrationEvent = {
        source: 'email',
        externalId: 'ext_123',
        eventType: 'issue_comment',
        payload: { subject: 'Test', body: 'Hello' },
        receivedAt: new Date().toISOString(),
      };
      const result = await adapter.transform(event);
      expect(result).toBeNull();
    });
  });
});

// ── Type Constants ─────────────────────────────────────────────────────

describe('adapter constants', () => {
  it('ADAPTER_CAPABILITIES contains expected capability values', () => {
    expect(ADAPTER_CAPABILITIES).toContain('send');
    expect(ADAPTER_CAPABILITIES).toContain('receive');
    expect(ADAPTER_CAPABILITIES).toContain('poll');
    expect(ADAPTER_CAPABILITIES).toContain('transform');
    expect(ADAPTER_CAPABILITIES).toContain('none');
  });

  it('INTEGRATION_EVENT_TYPES contains expected event types', () => {
    expect(INTEGRATION_EVENT_TYPES).toContain('issue_created');
    expect(INTEGRATION_EVENT_TYPES).toContain('issue_comment');
    expect(INTEGRATION_EVENT_TYPES).toContain('pull_request');
    expect(INTEGRATION_EVENT_TYPES).toContain('email_received');
    expect(INTEGRATION_EVENT_TYPES).toContain('ticket_update');
    expect(INTEGRATION_EVENT_TYPES).toContain('mention');
  });
});

// ── Extension Seam Verification ────────────────────────────────────────

describe('extension seam verification', () => {
  it('transport adapter can be replaced with custom implementation', () => {
    // Verify that a custom class can implement the TransportAdapter interface
    class CustomTransport implements TransportAdapter {
      async send(envelope: TransportEnvelope): Promise<TransportResult> {
        return {
          delivered: true,
          localId: envelope.id,
          remoteId: 'remote_abc',
          reason: null,
        };
      }
      async receive(): Promise<TransportEnvelope[]> {
        return [];
      }
      metadata(): AdapterMetadata {
        return {
          name: 'custom-relay',
          version: '1.0.0',
          description: 'Custom relay transport',
          capabilities: ['send', 'receive'],
        };
      }
    }

    const adapter: TransportAdapter = new CustomTransport();
    expect(adapter.metadata().name).toBe('custom-relay');
    expect(adapter.metadata().capabilities).toEqual(['send', 'receive']);
  });

  it('integration adapter can be replaced with custom implementation', () => {
    class CustomGitHub implements IntegrationAdapter {
      async poll(): Promise<IntegrationEvent[]> {
        return [
          {
            source: 'github',
            externalId: 'gh_issue_42',
            eventType: 'issue_comment',
            payload: { body: 'LGTM' },
            receivedAt: new Date().toISOString(),
          },
        ];
      }
      async transform(event: IntegrationEvent): Promise<TransportEnvelope | null> {
        return makeEnvelope({ body: String(event.payload.body) });
      }
      metadata(): AdapterMetadata {
        return {
          name: 'github',
          version: '1.0.0',
          description: 'GitHub integration adapter',
          capabilities: ['poll', 'transform'],
        };
      }
    }

    const adapter: IntegrationAdapter = new CustomGitHub();
    expect(adapter.metadata().name).toBe('github');
    expect(adapter.metadata().capabilities).toContain('poll');
  });

  it('adapter types compose with existing MessageEnvelope', () => {
    // TransportEnvelope is MessageEnvelope — verify compatibility
    const envelope = makeEnvelope();
    const transportEnvelope: TransportEnvelope = envelope;
    expect(transportEnvelope.id).toBe(envelope.id);
    expect(transportEnvelope.thread_id).toBe(envelope.thread_id);
    expect(transportEnvelope.body).toBe(envelope.body);
  });
});

// ── Core Flow Isolation ────────────────────────────────────────────────

describe('core flow isolation', () => {
  it('importing adapters does not modify contract module', async () => {
    // Importing the adapter module should not side-effect the contract module
    const contractModule = await import('../src/contract/index.js');
    // Verify core exports are unmodified
    expect(typeof contractModule.validateEnvelope).toBe('function');
    expect(typeof contractModule.generateMessageId).toBe('function');
    expect(typeof contractModule.validateStateTransition).toBe('function');
    expect(contractModule.DELIVERY_STATES).toEqual(['queued', 'delivered', 'acked', 'failed']);
  });

  it('adapter stubs introduce no active behavior', async () => {
    const transport = new NoopTransportAdapter();
    const integration = new NoopIntegrationAdapter('github');

    // All noop operations should resolve without side effects
    const sendResult = await transport.send(makeEnvelope());
    const receiveResult = await transport.receive();
    const pollResult = await integration.poll();
    const transformResult = await integration.transform({
      source: 'github',
      externalId: 'ext_1',
      eventType: 'issue_created',
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    expect(sendResult.delivered).toBe(false);
    expect(receiveResult).toHaveLength(0);
    expect(pollResult).toHaveLength(0);
    expect(transformResult).toBeNull();
  });
});
