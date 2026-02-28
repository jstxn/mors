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
  isValidPrefixedId,
  ID_PREFIXES,
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
import { ContractValidationError, InvalidStateTransitionError } from '../src/contract/errors.js';

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

    it('returns false for undefined (only null is accepted, not undefined)', () => {
      expect(isValidOptionalId(undefined)).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isValidOptionalId('')).toBe(false);
    });

    it('returns false for non-string types', () => {
      expect(isValidOptionalId(123)).toBe(false);
      expect(isValidOptionalId({})).toBe(false);
      expect(isValidOptionalId(true)).toBe(false);
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
      expect(() => validateStateTransition('queued', 'acked')).toThrow(InvalidStateTransitionError);
    });

    it('rejects acked -> anything (terminal state)', () => {
      expect(() => validateStateTransition('acked', 'delivered')).toThrow(
        InvalidStateTransitionError
      );
      expect(() => validateStateTransition('acked', 'queued')).toThrow(InvalidStateTransitionError);
      expect(() => validateStateTransition('acked', 'failed')).toThrow(InvalidStateTransitionError);
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
      expect(() => validateStateTransition('bogus' as DeliveryState, 'delivered')).toThrow(
        InvalidStateTransitionError
      );
    });

    it('rejects invalid to-state', () => {
      expect(() => validateStateTransition('queued', 'bogus' as DeliveryState)).toThrow(
        InvalidStateTransitionError
      );
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
      expect(() => validateEnvelope(validEnvelope({ id: '' }))).toThrow(ContractValidationError);
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
      expect(() => validateEnvelope(validEnvelope({ body: '' }))).toThrow(ContractValidationError);
    });

    it('rejects envelope with invalid state', () => {
      expect(() => validateEnvelope(validEnvelope({ state: 'bogus' as DeliveryState }))).toThrow(
        ContractValidationError
      );
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
      expect(() => validateEnvelopeForSend(validEnvelope({ state: 'delivered' }))).toThrow(
        ContractValidationError
      );
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
      expect(() => validateEnvelopeForReply(validEnvelope({ in_reply_to: null }))).toThrow(
        ContractValidationError
      );
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
      expect(() => validateMessageId(null as unknown as string)).toThrow(ContractValidationError);
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

// ---------------------------------------------------------------------------
// ID prefix validation
// ---------------------------------------------------------------------------

describe('typed ID prefix validation', () => {
  describe('ID_PREFIXES', () => {
    it('maps message to msg_ prefix', () => {
      expect(ID_PREFIXES.message).toBe('msg_');
    });

    it('maps thread to thr_ prefix', () => {
      expect(ID_PREFIXES.thread).toBe('thr_');
    });

    it('maps trace to trc_ prefix', () => {
      expect(ID_PREFIXES.trace).toBe('trc_');
    });

    it('maps dedupe to dup_ prefix', () => {
      expect(ID_PREFIXES.dedupe).toBe('dup_');
    });
  });

  describe('isValidPrefixedId', () => {
    it('returns true for correctly prefixed message ID', () => {
      expect(isValidPrefixedId('msg_abc123', 'message')).toBe(true);
    });

    it('returns true for correctly prefixed thread ID', () => {
      expect(isValidPrefixedId('thr_abc123', 'thread')).toBe(true);
    });

    it('returns true for correctly prefixed trace ID', () => {
      expect(isValidPrefixedId('trc_abc123', 'trace')).toBe(true);
    });

    it('returns true for correctly prefixed dedupe key', () => {
      expect(isValidPrefixedId('dup_abc123', 'dedupe')).toBe(true);
    });

    it('rejects message ID with wrong prefix', () => {
      expect(isValidPrefixedId('thr_abc123', 'message')).toBe(false);
    });

    it('rejects thread ID with wrong prefix', () => {
      expect(isValidPrefixedId('msg_abc123', 'thread')).toBe(false);
    });

    it('rejects trace ID with wrong prefix', () => {
      expect(isValidPrefixedId('msg_abc123', 'trace')).toBe(false);
    });

    it('rejects dedupe key with wrong prefix', () => {
      expect(isValidPrefixedId('msg_abc123', 'dedupe')).toBe(false);
    });

    it('rejects ID with prefix only (no content after prefix)', () => {
      expect(isValidPrefixedId('msg_', 'message')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isValidPrefixedId('', 'message')).toBe(false);
    });

    it('rejects null', () => {
      expect(isValidPrefixedId(null as unknown as string, 'message')).toBe(false);
    });

    it('rejects undefined', () => {
      expect(isValidPrefixedId(undefined as unknown as string, 'message')).toBe(false);
    });

    it('rejects non-string values', () => {
      expect(isValidPrefixedId(123 as unknown as string, 'message')).toBe(false);
    });

    it('rejects unprefixed but otherwise valid string', () => {
      expect(isValidPrefixedId('some_random_id', 'message')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Envelope undefined nullable field rejection
// ---------------------------------------------------------------------------

describe('envelope undefined nullable field rejection', () => {
  function validEnvelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
    return {
      id: 'msg_undef_test',
      thread_id: 'thr_undef_test',
      in_reply_to: null,
      sender: 'alice',
      recipient: 'bob',
      subject: null,
      body: 'Test undefined rejection',
      dedupe_key: null,
      trace_id: 'trc_undef_test',
      state: 'queued',
      read_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  }

  // Helper to simulate external input where a field is missing (undefined).
  // Uses destructuring to omit the target field then spreads back into a fresh
  // object, leaving the named key absent (i.e. property access yields undefined).
  function withUndefinedField(field: keyof MessageEnvelope): MessageEnvelope {
    const env = validEnvelope();
    const { [field]: _omitted, ...rest } = env;
    return rest as MessageEnvelope;
  }

  it('rejects envelope with undefined in_reply_to', () => {
    expect(() => validateEnvelope(withUndefinedField('in_reply_to'))).toThrow(
      ContractValidationError
    );
  });

  it('rejects envelope with undefined dedupe_key', () => {
    expect(() => validateEnvelope(withUndefinedField('dedupe_key'))).toThrow(
      ContractValidationError
    );
  });

  it('rejects envelope with undefined trace_id', () => {
    expect(() => validateEnvelope(withUndefinedField('trace_id'))).toThrow(ContractValidationError);
  });

  it('rejects envelope with undefined subject', () => {
    expect(() => validateEnvelope(withUndefinedField('subject'))).toThrow(ContractValidationError);
  });

  it('rejects envelope with undefined read_at', () => {
    expect(() => validateEnvelope(withUndefinedField('read_at'))).toThrow(ContractValidationError);
  });

  it('accepts envelope with null in_reply_to', () => {
    expect(() => validateEnvelope(validEnvelope({ in_reply_to: null }))).not.toThrow();
  });

  it('accepts envelope with null dedupe_key', () => {
    expect(() => validateEnvelope(validEnvelope({ dedupe_key: null }))).not.toThrow();
  });

  it('accepts envelope with null trace_id', () => {
    expect(() => validateEnvelope(validEnvelope({ trace_id: null }))).not.toThrow();
  });

  it('accepts envelope with null subject', () => {
    expect(() => validateEnvelope(validEnvelope({ subject: null }))).not.toThrow();
  });

  it('accepts envelope with null read_at', () => {
    expect(() => validateEnvelope(validEnvelope({ read_at: null }))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Envelope typed ID prefix enforcement
// ---------------------------------------------------------------------------

describe('envelope typed ID prefix enforcement', () => {
  function validEnvelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
    return {
      id: 'msg_prefix_test',
      thread_id: 'thr_prefix_test',
      in_reply_to: null,
      sender: 'alice',
      recipient: 'bob',
      subject: null,
      body: 'Test prefix enforcement',
      dedupe_key: null,
      trace_id: 'trc_prefix_test',
      state: 'queued',
      read_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  }

  it('rejects envelope with id missing msg_ prefix', () => {
    expect(() => validateEnvelope(validEnvelope({ id: 'no_prefix_id' }))).toThrow(
      ContractValidationError
    );
  });

  it('rejects envelope with thread_id missing thr_ prefix', () => {
    expect(() => validateEnvelope(validEnvelope({ thread_id: 'no_prefix_thread' }))).toThrow(
      ContractValidationError
    );
  });

  it('rejects envelope with in_reply_to missing msg_ prefix', () => {
    expect(() => validateEnvelope(validEnvelope({ in_reply_to: 'no_prefix_reply' }))).toThrow(
      ContractValidationError
    );
  });

  it('rejects envelope with dedupe_key missing dup_ prefix', () => {
    expect(() => validateEnvelope(validEnvelope({ dedupe_key: 'no_prefix_dedupe' }))).toThrow(
      ContractValidationError
    );
  });

  it('rejects envelope with trace_id missing trc_ prefix', () => {
    expect(() => validateEnvelope(validEnvelope({ trace_id: 'no_prefix_trace' }))).toThrow(
      ContractValidationError
    );
  });

  it('accepts envelope with correctly prefixed IDs', () => {
    expect(() =>
      validateEnvelope(
        validEnvelope({
          id: 'msg_correct',
          thread_id: 'thr_correct',
          in_reply_to: 'msg_parent',
          dedupe_key: 'dup_correct',
          trace_id: 'trc_correct',
        })
      )
    ).not.toThrow();
  });

  it('rejects id with thr_ prefix (wrong type)', () => {
    expect(() => validateEnvelope(validEnvelope({ id: 'thr_wrong' }))).toThrow(
      ContractValidationError
    );
  });

  it('rejects thread_id with msg_ prefix (wrong type)', () => {
    expect(() => validateEnvelope(validEnvelope({ thread_id: 'msg_wrong' }))).toThrow(
      ContractValidationError
    );
  });

  it('allows null optional ID fields without prefix check', () => {
    expect(() =>
      validateEnvelope(
        validEnvelope({
          in_reply_to: null,
          dedupe_key: null,
          trace_id: null,
        })
      )
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateMessageId prefix enforcement
// ---------------------------------------------------------------------------

describe('validateMessageId prefix enforcement', () => {
  it('accepts msg_ prefixed ID', () => {
    expect(() => validateMessageId('msg_test123')).not.toThrow();
  });

  it('rejects ID without msg_ prefix', () => {
    expect(() => validateMessageId('thr_wrong')).toThrow(ContractValidationError);
  });

  it('rejects unprefixed string', () => {
    expect(() => validateMessageId('random_id')).toThrow(ContractValidationError);
  });

  it('rejects msg_ prefix with no content after', () => {
    expect(() => validateMessageId('msg_')).toThrow(ContractValidationError);
  });
});
