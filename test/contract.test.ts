/**
 * Tests for envelope/state contracts — IDs, dedupe, trace_id, read_at,
 * thread fields, delivery states, and shared validators/types.
 *
 * Covers the contract module that enforces envelope/state shape used by
 * all CLI commands (send, read, reply, ack, watch, inbox).
 */

import { describe, it, expect } from 'vitest';
import {
  generateMessageId,
  generateThreadId,
  generateTraceId,
  generateDedupeKey,
  isValidId,
  isValidOptionalId,
} from '../src/contract/ids.js';
import {
  DELIVERY_STATES,
  ALLOWED_TRANSITIONS,
  isValidDeliveryState,
  validateStateTransition,
  type DeliveryState,
} from '../src/contract/states.js';
import {
  validateEnvelope,
  validateEnvelopeForSend,
  validateEnvelopeForReply,
  validateMessageId,
  type MessageEnvelope,
} from '../src/contract/envelope.js';
import {
  ContractValidationError,
  InvalidStateTransitionError,
} from '../src/contract/errors.js';

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

describe('contract ID generation', () => {
  describe('generateMessageId', () => {
    it('returns a non-empty string', () => {
      const id = generateMessageId();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('generates unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateMessageId()));
      expect(ids.size).toBe(100);
    });

    it('starts with msg_ prefix', () => {
      const id = generateMessageId();
      expect(id.startsWith('msg_')).toBe(true);
    });
  });

  describe('generateThreadId', () => {
    it('returns a non-empty string', () => {
      const id = generateThreadId();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('generates unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateThreadId()));
      expect(ids.size).toBe(100);
    });

    it('starts with thr_ prefix', () => {
      const id = generateThreadId();
      expect(id.startsWith('thr_')).toBe(true);
    });
  });

  describe('generateTraceId', () => {
    it('returns a non-empty string', () => {
      const id = generateTraceId();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('generates unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateTraceId()));
      expect(ids.size).toBe(100);
    });

    it('starts with trc_ prefix', () => {
      const id = generateTraceId();
      expect(id.startsWith('trc_')).toBe(true);
    });
  });

  describe('generateDedupeKey', () => {
    it('returns a non-empty string', () => {
      const key = generateDedupeKey();
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    });

    it('generates unique keys', () => {
      const keys = new Set(Array.from({ length: 100 }, () => generateDedupeKey()));
      expect(keys.size).toBe(100);
    });

    it('starts with dup_ prefix', () => {
      const key = generateDedupeKey();
      expect(key.startsWith('dup_')).toBe(true);
    });
  });

  describe('isValidId', () => {
    it('returns true for valid IDs', () => {
      expect(isValidId('msg_abc123')).toBe(true);
      expect(isValidId('thr_xyz')).toBe(true);
      expect(isValidId('trc_test')).toBe(true);
    });

    it('returns false for empty string', () => {
      expect(isValidId('')).toBe(false);
    });

    it('returns false for whitespace-only string', () => {
      expect(isValidId('   ')).toBe(false);
    });

    it('returns false for non-string values', () => {
      expect(isValidId(null as unknown as string)).toBe(false);
      expect(isValidId(undefined as unknown as string)).toBe(false);
      expect(isValidId(123 as unknown as string)).toBe(false);
    });
  });

  describe('isValidOptionalId', () => {
    it('returns true for valid IDs', () => {
      expect(isValidOptionalId('msg_abc')).toBe(true);
    });

    it('returns true for null', () => {
      expect(isValidOptionalId(null)).toBe(true);
    });

    it('returns true for undefined', () => {
      expect(isValidOptionalId(undefined)).toBe(true);
    });

    it('returns false for empty string', () => {
      expect(isValidOptionalId('')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Delivery states
// ---------------------------------------------------------------------------

describe('delivery states', () => {
  describe('DELIVERY_STATES', () => {
    it('contains exactly queued, delivered, acked, failed', () => {
      expect(DELIVERY_STATES).toEqual(['queued', 'delivered', 'acked', 'failed']);
    });
  });

  describe('isValidDeliveryState', () => {
    it('returns true for all valid states', () => {
      for (const state of DELIVERY_STATES) {
        expect(isValidDeliveryState(state)).toBe(true);
      }
    });

    it('returns false for invalid states', () => {
      expect(isValidDeliveryState('pending')).toBe(false);
      expect(isValidDeliveryState('sent')).toBe(false);
      expect(isValidDeliveryState('')).toBe(false);
      expect(isValidDeliveryState(null as unknown as string)).toBe(false);
    });
  });

  describe('ALLOWED_TRANSITIONS', () => {
    it('queued can transition to delivered or failed', () => {
      expect(ALLOWED_TRANSITIONS.queued).toEqual(['delivered', 'failed']);
    });

    it('delivered can transition to acked or failed', () => {
      expect(ALLOWED_TRANSITIONS.delivered).toEqual(['acked', 'failed']);
    });

    it('acked is a terminal state (no transitions)', () => {
      expect(ALLOWED_TRANSITIONS.acked).toEqual([]);
    });

    it('failed is a terminal state (no transitions)', () => {
      expect(ALLOWED_TRANSITIONS.failed).toEqual([]);
    });
  });

  describe('validateStateTransition', () => {
    it('allows queued -> delivered', () => {
      expect(() => validateStateTransition('queued', 'delivered')).not.toThrow();
    });

    it('allows queued -> failed', () => {
      expect(() => validateStateTransition('queued', 'failed')).not.toThrow();
    });

    it('allows delivered -> acked', () => {
      expect(() => validateStateTransition('delivered', 'acked')).not.toThrow();
    });

    it('allows delivered -> failed', () => {
      expect(() => validateStateTransition('delivered', 'failed')).not.toThrow();
    });

    it('rejects queued -> acked (skipping delivered)', () => {
      expect(() => validateStateTransition('queued', 'acked')).toThrow(
        InvalidStateTransitionError
      );
    });

    it('rejects acked -> anything (terminal state)', () => {
      expect(() => validateStateTransition('acked', 'delivered')).toThrow(
        InvalidStateTransitionError
      );
      expect(() => validateStateTransition('acked', 'queued')).toThrow(
        InvalidStateTransitionError
      );
      expect(() => validateStateTransition('acked', 'failed')).toThrow(
        InvalidStateTransitionError
      );
    });

    it('rejects failed -> anything (terminal state)', () => {
      expect(() => validateStateTransition('failed', 'queued')).toThrow(
        InvalidStateTransitionError
      );
      expect(() => validateStateTransition('failed', 'delivered')).toThrow(
        InvalidStateTransitionError
      );
    });

    it('rejects delivered -> queued (backwards transition)', () => {
      expect(() => validateStateTransition('delivered', 'queued')).toThrow(
        InvalidStateTransitionError
      );
    });

    it('rejects same-state transitions', () => {
      expect(() => validateStateTransition('queued', 'queued')).toThrow(
        InvalidStateTransitionError
      );
      expect(() => validateStateTransition('delivered', 'delivered')).toThrow(
        InvalidStateTransitionError
      );
    });

    it('error message includes from and to states', () => {
      try {
        validateStateTransition('queued', 'acked');
        expect.unreachable('Should have thrown');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(InvalidStateTransitionError);
        const msg = (err as Error).message;
        expect(msg).toContain('queued');
        expect(msg).toContain('acked');
      }
    });

    it('rejects invalid from-state', () => {
      expect(() =>
        validateStateTransition('bogus' as DeliveryState, 'delivered')
      ).toThrow(InvalidStateTransitionError);
    });

    it('rejects invalid to-state', () => {
      expect(() =>
        validateStateTransition('queued', 'bogus' as DeliveryState)
      ).toThrow(InvalidStateTransitionError);
    });
  });
});

// ---------------------------------------------------------------------------
// Envelope validation
// ---------------------------------------------------------------------------

describe('envelope validation', () => {
  function validEnvelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
    return {
      id: 'msg_test123',
      thread_id: 'thr_test123',
      in_reply_to: null,
      sender: 'alice',
      recipient: 'bob',
      subject: null,
      body: 'Hello, world!',
      dedupe_key: null,
      trace_id: 'trc_test123',
      state: 'queued',
      read_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  }

  describe('validateEnvelope', () => {
    it('accepts a valid envelope', () => {
      expect(() => validateEnvelope(validEnvelope())).not.toThrow();
    });

    it('accepts envelope with all optional fields set', () => {
      const env = validEnvelope({
        in_reply_to: 'msg_parent',
        subject: 'Test subject',
        dedupe_key: 'dup_test',
        read_at: new Date().toISOString(),
      });
      expect(() => validateEnvelope(env)).not.toThrow();
    });

    it('rejects envelope with missing id', () => {
      expect(() => validateEnvelope(validEnvelope({ id: '' }))).toThrow(
        ContractValidationError
      );
    });

    it('rejects envelope with missing thread_id', () => {
      expect(() => validateEnvelope(validEnvelope({ thread_id: '' }))).toThrow(
        ContractValidationError
      );
    });

    it('rejects envelope with missing sender', () => {
      expect(() => validateEnvelope(validEnvelope({ sender: '' }))).toThrow(
        ContractValidationError
      );
    });

    it('rejects envelope with missing recipient', () => {
      expect(() => validateEnvelope(validEnvelope({ recipient: '' }))).toThrow(
        ContractValidationError
      );
    });

    it('rejects envelope with missing body', () => {
      expect(() => validateEnvelope(validEnvelope({ body: '' }))).toThrow(
        ContractValidationError
      );
    });

    it('rejects envelope with invalid state', () => {
      expect(() =>
        validateEnvelope(validEnvelope({ state: 'bogus' as DeliveryState }))
      ).toThrow(ContractValidationError);
    });

    it('rejects envelope with missing created_at', () => {
      expect(() => validateEnvelope(validEnvelope({ created_at: '' }))).toThrow(
        ContractValidationError
      );
    });

    it('rejects envelope with missing updated_at', () => {
      expect(() => validateEnvelope(validEnvelope({ updated_at: '' }))).toThrow(
        ContractValidationError
      );
    });

    it('rejects envelope with empty string in_reply_to (should be null)', () => {
      expect(() => validateEnvelope(validEnvelope({ in_reply_to: '' }))).toThrow(
        ContractValidationError
      );
    });

    it('rejects envelope with empty string dedupe_key (should be null)', () => {
      expect(() => validateEnvelope(validEnvelope({ dedupe_key: '' }))).toThrow(
        ContractValidationError
      );
    });

    it('rejects envelope with empty string trace_id', () => {
      expect(() => validateEnvelope(validEnvelope({ trace_id: '' }))).toThrow(
        ContractValidationError
      );
    });

    it('error message identifies which field is invalid', () => {
      try {
        validateEnvelope(validEnvelope({ id: '' }));
        expect.unreachable('Should have thrown');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ContractValidationError);
        expect((err as Error).message).toContain('id');
      }
    });

    it('rejects null envelope', () => {
      expect(() => validateEnvelope(null as unknown as MessageEnvelope)).toThrow(
        ContractValidationError
      );
    });

    it('rejects undefined envelope', () => {
      expect(() => validateEnvelope(undefined as unknown as MessageEnvelope)).toThrow(
        ContractValidationError
      );
    });
  });

  describe('validateEnvelopeForSend', () => {
    it('accepts a valid send envelope', () => {
      const env = validEnvelope({ state: 'queued' });
      expect(() => validateEnvelopeForSend(env)).not.toThrow();
    });

    it('rejects non-queued initial state', () => {
      expect(() =>
        validateEnvelopeForSend(validEnvelope({ state: 'delivered' }))
      ).toThrow(ContractValidationError);
    });

    it('rejects send envelope with read_at set', () => {
      expect(() =>
        validateEnvelopeForSend(validEnvelope({ read_at: new Date().toISOString() }))
      ).toThrow(ContractValidationError);
    });

    it('accepts send envelope with optional dedupe_key', () => {
      const env = validEnvelope({ dedupe_key: 'dup_abc123' });
      expect(() => validateEnvelopeForSend(env)).not.toThrow();
    });

    it('accepts send envelope with optional trace_id', () => {
      const env = validEnvelope({ trace_id: 'trc_abc123' });
      expect(() => validateEnvelopeForSend(env)).not.toThrow();
    });

    it('accepts send envelope without in_reply_to for new message', () => {
      const env = validEnvelope({ in_reply_to: null });
      expect(() => validateEnvelopeForSend(env)).not.toThrow();
    });
  });

  describe('validateEnvelopeForReply', () => {
    it('accepts a valid reply envelope', () => {
      const env = validEnvelope({
        in_reply_to: 'msg_parent',
        state: 'queued',
      });
      expect(() => validateEnvelopeForReply(env)).not.toThrow();
    });

    it('rejects reply without in_reply_to', () => {
      expect(() =>
        validateEnvelopeForReply(validEnvelope({ in_reply_to: null }))
      ).toThrow(ContractValidationError);
    });
  });

  describe('validateMessageId', () => {
    it('accepts a valid message ID', () => {
      expect(() => validateMessageId('msg_test123')).not.toThrow();
    });

    it('rejects empty string', () => {
      expect(() => validateMessageId('')).toThrow(ContractValidationError);
    });

    it('rejects null', () => {
      expect(() => validateMessageId(null as unknown as string)).toThrow(
        ContractValidationError
      );
    });

    it('rejects whitespace-only string', () => {
      expect(() => validateMessageId('   ')).toThrow(ContractValidationError);
    });
  });
});

// ---------------------------------------------------------------------------
// Contract errors
// ---------------------------------------------------------------------------

describe('contract errors', () => {
  it('ContractValidationError extends MorsError', () => {
    const err = new ContractValidationError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ContractValidationError');
    expect(err.message).toBe('test');
  });

  it('InvalidStateTransitionError extends MorsError', () => {
    const err = new InvalidStateTransitionError('queued', 'acked');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('InvalidStateTransitionError');
    expect(err.message).toContain('queued');
    expect(err.message).toContain('acked');
  });

  it('InvalidStateTransitionError exposes from and to properties', () => {
    const err = new InvalidStateTransitionError('queued', 'acked');
    expect(err.from).toBe('queued');
    expect(err.to).toBe('acked');
  });
});

// ---------------------------------------------------------------------------
// Envelope read_at semantics
// ---------------------------------------------------------------------------

describe('envelope read_at semantics', () => {
  function validEnvelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
    return {
      id: 'msg_readat_test',
      thread_id: 'thr_readat_test',
      in_reply_to: null,
      sender: 'alice',
      recipient: 'bob',
      subject: null,
      body: 'Test read_at',
      dedupe_key: null,
      trace_id: 'trc_readat_test',
      state: 'delivered',
      read_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  }

  it('read_at null means unread', () => {
    const env = validEnvelope({ read_at: null });
    expect(env.read_at).toBeNull();
  });

  it('read_at set means read', () => {
    const timestamp = new Date().toISOString();
    const env = validEnvelope({ read_at: timestamp });
    expect(env.read_at).toBe(timestamp);
  });

  it('read_at is independent from ack state', () => {
    // A message can be read (read_at set) but not acked (state=delivered)
    const env = validEnvelope({
      read_at: new Date().toISOString(),
      state: 'delivered',
    });
    expect(env.read_at).not.toBeNull();
    expect(env.state).toBe('delivered');
    expect(() => validateEnvelope(env)).not.toThrow();
  });

  it('queued messages should not have read_at set', () => {
    const env = validEnvelope({
      read_at: new Date().toISOString(),
      state: 'queued',
    });
    // validateEnvelopeForSend should reject this
    expect(() => validateEnvelopeForSend(env)).toThrow(ContractValidationError);
  });
});

// ---------------------------------------------------------------------------
// Thread field semantics
// ---------------------------------------------------------------------------

describe('thread field semantics', () => {
  function validEnvelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
    return {
      id: 'msg_thread_test',
      thread_id: 'thr_thread_test',
      in_reply_to: null,
      sender: 'alice',
      recipient: 'bob',
      subject: null,
      body: 'Test threading',
      dedupe_key: null,
      trace_id: 'trc_thread_test',
      state: 'queued',
      read_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  }

  it('new messages have thread_id but no in_reply_to', () => {
    const env = validEnvelope({ in_reply_to: null });
    expect(env.thread_id).toBeTruthy();
    expect(env.in_reply_to).toBeNull();
    expect(() => validateEnvelope(env)).not.toThrow();
  });

  it('reply messages must have both thread_id and in_reply_to', () => {
    const env = validEnvelope({
      in_reply_to: 'msg_parent',
    });
    expect(() => validateEnvelopeForReply(env)).not.toThrow();
  });

  it('reply must share thread_id with parent (validated at command level, not here)', () => {
    // Note: thread_id matching parent is an application-level concern,
    // the contract only validates that thread_id and in_reply_to are present.
    const env = validEnvelope({
      thread_id: 'thr_shared',
      in_reply_to: 'msg_parent',
    });
    expect(() => validateEnvelopeForReply(env)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Dedupe key semantics
// ---------------------------------------------------------------------------

describe('dedupe key semantics', () => {
  it('dedupe_key is optional (can be null)', () => {
    const env: MessageEnvelope = {
      id: 'msg_dedupe_test',
      thread_id: 'thr_dedupe_test',
      in_reply_to: null,
      sender: 'alice',
      recipient: 'bob',
      subject: null,
      body: 'Test dedupe',
      dedupe_key: null,
      trace_id: 'trc_dedupe_test',
      state: 'queued',
      read_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    expect(() => validateEnvelope(env)).not.toThrow();
  });

  it('dedupe_key when provided must be non-empty', () => {
    const env: MessageEnvelope = {
      id: 'msg_dedupe_test2',
      thread_id: 'thr_dedupe_test2',
      in_reply_to: null,
      sender: 'alice',
      recipient: 'bob',
      subject: null,
      body: 'Test dedupe 2',
      dedupe_key: '',
      trace_id: 'trc_dedupe_test2',
      state: 'queued',
      read_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    expect(() => validateEnvelope(env)).toThrow(ContractValidationError);
  });
});

// ---------------------------------------------------------------------------
// trace_id semantics
// ---------------------------------------------------------------------------

describe('trace_id semantics', () => {
  it('trace_id when provided must be non-empty', () => {
    const env: MessageEnvelope = {
      id: 'msg_trace_test',
      thread_id: 'thr_trace_test',
      in_reply_to: null,
      sender: 'alice',
      recipient: 'bob',
      subject: null,
      body: 'Test trace',
      dedupe_key: null,
      trace_id: '',
      state: 'queued',
      read_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    expect(() => validateEnvelope(env)).toThrow(ContractValidationError);
  });

  it('trace_id can be null', () => {
    const env: MessageEnvelope = {
      id: 'msg_trace_test2',
      thread_id: 'thr_trace_test2',
      in_reply_to: null,
      sender: 'alice',
      recipient: 'bob',
      subject: null,
      body: 'Test trace 2',
      dedupe_key: null,
      trace_id: null,
      state: 'queued',
      read_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    expect(() => validateEnvelope(env)).not.toThrow();
  });
});
