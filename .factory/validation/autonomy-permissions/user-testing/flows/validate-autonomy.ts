/**
 * Inline flow validation for autonomy-permissions milestone.
 *
 * Tests VAL-RELAY-011, VAL-RELAY-012, VAL-RELAY-013 against a running relay on port 3100.
 * Generates signed native tokens using MORS_RELAY_SIGNING_KEY.
 */

import { createHmac, randomUUID } from 'node:crypto';

/**
 * Inline token generation (mirrors src/auth/native.ts generateSessionToken)
 * to avoid relative-import path issues from .factory directory.
 */
function generateSessionToken(options: {
  accountId: string;
  deviceId: string;
  signingKey: string;
}): string {
  const payload = {
    accountId: options.accountId,
    deviceId: options.deviceId,
    issuedAt: new Date().toISOString(),
    tokenId: randomUUID(),
  };
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', options.signingKey).update(payloadStr).digest('hex');
  return `mors-session.${payloadStr}.${signature}`;
}

const RELAY_URL = 'http://127.0.0.1:3100';
const SIGNING_KEY = 'test-signing-key-for-validation';

// Generate test tokens
const ALICE_TOKEN = generateSessionToken({
  accountId: 'acct_alice_val',
  deviceId: 'dev-alice-1',
  signingKey: SIGNING_KEY,
});
const BOB_TOKEN = generateSessionToken({
  accountId: 'acct_bob_val',
  deviceId: 'dev-bob-1',
  signingKey: SIGNING_KEY,
});
const CHARLIE_TOKEN = generateSessionToken({
  accountId: 'acct_charlie_val',
  deviceId: 'dev-charlie-1',
  signingKey: SIGNING_KEY,
});

interface TestResult {
  name: string;
  assertion: string;
  passed: boolean;
  evidence: string;
  error?: string;
}

const results: TestResult[] = [];

async function relayFetch(
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {}
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;

  const res = await fetch(`${RELAY_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

// ── VAL-RELAY-011: Delivery to inbox is always allowed ──────────────

async function testVAL_RELAY_011(): Promise<void> {
  console.log('\n=== VAL-RELAY-011: Delivery to inbox is always allowed ===\n');

  // Test 1: First-contact message from unknown sender is delivered
  {
    const name = 'First-contact message from unknown sender lands in inbox';
    try {
      const sendRes = await relayFetch('/messages', {
        method: 'POST',
        token: ALICE_TOKEN,
        body: { recipient_id: 'acct_bob_val', body: 'Hello from unknown sender Alice' },
      });
      assert(sendRes.status === 201, `Expected 201, got ${sendRes.status}`);
      const msg = sendRes.body as Record<string, unknown>;
      console.log(
        `  Send response: status=${sendRes.status}, id=${msg['id']}, first_contact=${msg['first_contact']}`
      );
      assert(msg['first_contact'] === true, 'Expected first_contact=true for unknown sender');

      // Check Bob's inbox
      const inboxRes = await relayFetch('/inbox', { token: BOB_TOKEN });
      const inbox = inboxRes.body as Record<string, unknown>;
      const messages = inbox['messages'] as Array<Record<string, unknown>>;
      const aliceMsg = messages.find((m) => m['body'] === 'Hello from unknown sender Alice');
      assert(aliceMsg !== undefined, 'Message from unknown sender not found in inbox');
      console.log(
        `  Inbox check: found message from Alice in Bob's inbox, state=${aliceMsg['state']}`
      );

      results.push({
        name,
        assertion: 'VAL-RELAY-011',
        passed: true,
        evidence: `Send returned 201 with first_contact=true. Message "${msg['id']}" found in Bob's inbox with state=${aliceMsg['state']}.`,
      });
    } catch (e) {
      results.push({
        name,
        assertion: 'VAL-RELAY-011',
        passed: false,
        evidence: '',
        error: String(e),
      });
    }
  }

  // Test 2: Multiple unknown senders all deliver to inbox
  {
    const name = 'Multiple unknown senders all deliver to same recipient inbox';
    try {
      const charlieRes = await relayFetch('/messages', {
        method: 'POST',
        token: CHARLIE_TOKEN,
        body: { recipient_id: 'acct_bob_val', body: 'Hello from unknown Charlie' },
      });
      assert(charlieRes.status === 201, `Charlie send: expected 201, got ${charlieRes.status}`);
      console.log(`  Charlie send: status=${charlieRes.status}`);

      const inboxRes = await relayFetch('/inbox', { token: BOB_TOKEN });
      const inbox = inboxRes.body as Record<string, unknown>;
      const messages = inbox['messages'] as Array<Record<string, unknown>>;
      const charlieMsg = messages.find((m) => m['body'] === 'Hello from unknown Charlie');
      assert(charlieMsg !== undefined, 'Charlie message not found in inbox');
      assert(messages.length >= 2, `Expected at least 2 messages, got ${messages.length}`);
      console.log(`  Bob inbox: ${messages.length} messages total, Charlie message found`);

      results.push({
        name,
        assertion: 'VAL-RELAY-011',
        passed: true,
        evidence: `Both Alice and Charlie (unknown senders) successfully delivered to Bob's inbox. Total inbox count: ${messages.length}.`,
      });
    } catch (e) {
      results.push({
        name,
        assertion: 'VAL-RELAY-011',
        passed: false,
        evidence: '',
        error: String(e),
      });
    }
  }

  // Test 3: Read and ack work on first-contact messages
  {
    const name = 'Read and ack work on first-contact messages';
    try {
      // Get the first message ID from inbox
      const inboxRes = await relayFetch('/inbox', { token: BOB_TOKEN });
      const messages = (inboxRes.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      const msgId = messages[0]['id'] as string;

      const readRes = await relayFetch(`/messages/${msgId}/read`, {
        method: 'POST',
        token: BOB_TOKEN,
      });
      assert(readRes.status === 200, `Read expected 200, got ${readRes.status}`);
      console.log(`  Read message ${msgId}: status=${readRes.status}`);

      const ackRes = await relayFetch(`/messages/${msgId}/ack`, {
        method: 'POST',
        token: BOB_TOKEN,
      });
      assert(ackRes.status === 200, `Ack expected 200, got ${ackRes.status}`);
      const ackMsg = (ackRes.body as Record<string, unknown>)['message'] as Record<string, unknown>;
      console.log(`  Ack message ${msgId}: status=${ackRes.status}, state=${ackMsg['state']}`);
      assert(ackMsg['state'] === 'acked', `Expected acked state, got ${ackMsg['state']}`);

      results.push({
        name,
        assertion: 'VAL-RELAY-011',
        passed: true,
        evidence: `Read returned 200, ack returned 200 with state=acked for first-contact message ${msgId}.`,
      });
    } catch (e) {
      results.push({
        name,
        assertion: 'VAL-RELAY-011',
        passed: false,
        evidence: '',
        error: String(e),
      });
    }
  }
}

// ── VAL-RELAY-012: First-contact permission gates autonomous actions only ──

async function testVAL_RELAY_012(): Promise<void> {
  console.log('\n=== VAL-RELAY-012: First-contact permission gates autonomous actions only ===\n');

  // Test 1: Contact status for unknown sender shows pending/no autonomy
  {
    const name = 'Unknown sender contact status shows pending with autonomy_allowed=false';
    try {
      // Use a fresh unknown sender for Bob
      const statusRes = await relayFetch('/contacts/status', {
        method: 'POST',
        token: BOB_TOKEN,
        body: { contact_account_id: 'acct_unknown_sender' },
      });
      assert(statusRes.status === 200, `Expected 200, got ${statusRes.status}`);
      const result = statusRes.body as Record<string, unknown>;
      console.log(
        `  Contact status (unknown): status=${result['status']}, autonomy_allowed=${result['autonomy_allowed']}`
      );
      assert(result['status'] === 'pending', `Expected pending, got ${result['status']}`);
      assert(result['autonomy_allowed'] === false, `Expected autonomy_allowed=false`);

      results.push({
        name,
        assertion: 'VAL-RELAY-012',
        passed: true,
        evidence: `Contact status API returned status=pending, autonomy_allowed=false for unknown sender.`,
      });
    } catch (e) {
      results.push({
        name,
        assertion: 'VAL-RELAY-012',
        passed: false,
        evidence: '',
        error: String(e),
      });
    }
  }

  // Test 2: Approving a contact enables autonomy and is remembered
  {
    const name = 'Approving contact enables autonomy_allowed=true (remembered)';
    try {
      // Approve Alice for Bob
      const approveRes = await relayFetch('/contacts/approve', {
        method: 'POST',
        token: BOB_TOKEN,
        body: { contact_account_id: 'acct_alice_val' },
      });
      assert(approveRes.status === 200, `Approve expected 200, got ${approveRes.status}`);
      console.log(`  Approve Alice: status=${approveRes.status}`);

      // Check status after approval
      const statusRes = await relayFetch('/contacts/status', {
        method: 'POST',
        token: BOB_TOKEN,
        body: { contact_account_id: 'acct_alice_val' },
      });
      assert(statusRes.status === 200, `Status expected 200, got ${statusRes.status}`);
      const result = statusRes.body as Record<string, unknown>;
      console.log(
        `  Contact status (after approve): status=${result['status']}, autonomy_allowed=${result['autonomy_allowed']}`
      );
      assert(result['status'] === 'approved', `Expected approved, got ${result['status']}`);
      assert(result['autonomy_allowed'] === true, 'Expected autonomy_allowed=true after approval');

      // Check remembered: query again
      const secondCheck = await relayFetch('/contacts/status', {
        method: 'POST',
        token: BOB_TOKEN,
        body: { contact_account_id: 'acct_alice_val' },
      });
      const secondResult = secondCheck.body as Record<string, unknown>;
      assert(secondResult['status'] === 'approved', 'Approval not remembered on second check');
      console.log(`  Approval remembered: second check still approved`);

      results.push({
        name,
        assertion: 'VAL-RELAY-012',
        passed: true,
        evidence: `Approve API returned 200. Status changed from pending→approved with autonomy_allowed=true. Second check confirms approval is remembered.`,
      });
    } catch (e) {
      results.push({
        name,
        assertion: 'VAL-RELAY-012',
        passed: false,
        evidence: '',
        error: String(e),
      });
    }
  }

  // Test 3: Message from approved contact has autonomy_allowed=true
  {
    const name = 'Message from approved contact has first_contact=false, autonomy_allowed=true';
    try {
      // Alice was approved above. Send new message.
      const sendRes = await relayFetch('/messages', {
        method: 'POST',
        token: ALICE_TOKEN,
        body: { recipient_id: 'acct_bob_val', body: 'Message after approval' },
      });
      assert(sendRes.status === 201, `Send expected 201, got ${sendRes.status}`);
      const msg = sendRes.body as Record<string, unknown>;
      console.log(
        `  Send from approved Alice: first_contact=${msg['first_contact']}, autonomy_allowed=${msg['autonomy_allowed']}`
      );
      assert(msg['first_contact'] === false, 'Expected first_contact=false for approved sender');
      assert(
        msg['autonomy_allowed'] === true,
        'Expected autonomy_allowed=true for approved sender'
      );

      results.push({
        name,
        assertion: 'VAL-RELAY-012',
        passed: true,
        evidence: `Message from approved Alice: first_contact=false, autonomy_allowed=true. Delivery succeeded (201).`,
      });
    } catch (e) {
      results.push({
        name,
        assertion: 'VAL-RELAY-012',
        passed: false,
        evidence: '',
        error: String(e),
      });
    }
  }

  // Test 4: Message from unapproved contact has autonomy_allowed=false but delivery succeeds
  {
    const name = 'Unapproved contact: delivery succeeds but autonomy_allowed=false';
    try {
      // Charlie is NOT approved by Bob
      const sendRes = await relayFetch('/messages', {
        method: 'POST',
        token: CHARLIE_TOKEN,
        body: { recipient_id: 'acct_bob_val', body: 'Unapproved Charlie second message' },
      });
      assert(sendRes.status === 201, `Send expected 201, got ${sendRes.status}`);
      const msg = sendRes.body as Record<string, unknown>;
      console.log(
        `  Send from unapproved Charlie: first_contact=${msg['first_contact']}, autonomy_allowed=${msg['autonomy_allowed']}`
      );
      assert(msg['first_contact'] === true, 'Expected first_contact=true for unapproved sender');
      assert(
        msg['autonomy_allowed'] === false,
        'Expected autonomy_allowed=false for unapproved sender'
      );

      results.push({
        name,
        assertion: 'VAL-RELAY-012',
        passed: true,
        evidence: `Message from unapproved Charlie: first_contact=true, autonomy_allowed=false. Delivery still succeeded (201). Policy gates autonomy only, not delivery.`,
      });
    } catch (e) {
      results.push({
        name,
        assertion: 'VAL-RELAY-012',
        passed: false,
        evidence: '',
        error: String(e),
      });
    }
  }
}

// ── VAL-RELAY-013: Unknown senders in non-interactive mode remain pending ──

async function testVAL_RELAY_013(): Promise<void> {
  console.log(
    '\n=== VAL-RELAY-013: Unknown senders non-interactive mode pending, no auto-actions ===\n'
  );

  // Test 1: First-contact creates pending contact record
  {
    const name = 'First-contact sender creates pending contact record on delivery';
    try {
      // Charlie already sent to Bob. Check pending contacts list.
      const pendingRes = await relayFetch('/contacts/pending', { token: BOB_TOKEN });
      assert(pendingRes.status === 200, `Expected 200, got ${pendingRes.status}`);
      const result = pendingRes.body as Record<string, unknown>;
      const pending = result['pending'] as string[];
      console.log(`  Pending contacts for Bob: ${JSON.stringify(pending)}`);
      assert(pending.includes('acct_charlie_val'), 'Charlie should be in pending contacts');
      // Alice was approved above, so should NOT be in pending
      assert(
        !pending.includes('acct_alice_val'),
        'Alice (approved) should NOT be in pending contacts'
      );

      results.push({
        name,
        assertion: 'VAL-RELAY-013',
        passed: true,
        evidence: `Pending contacts: ${JSON.stringify(pending)}. Charlie (unapproved) is pending, Alice (approved) is not.`,
      });
    } catch (e) {
      results.push({
        name,
        assertion: 'VAL-RELAY-013',
        passed: false,
        evidence: '',
        error: String(e),
      });
    }
  }

  // Test 2: No auto-actions on pending contact messages (state remains delivered)
  {
    const name = 'No autonomous actions on messages from pending contacts (state=delivered)';
    try {
      // Send a fresh message from a brand-new unknown sender
      const newSenderToken = generateSessionToken({
        accountId: 'acct_new_unknown',
        deviceId: 'dev-new-1',
        signingKey: SIGNING_KEY,
      });
      const sendRes = await relayFetch('/messages', {
        method: 'POST',
        token: newSenderToken,
        body: { recipient_id: 'acct_bob_val', body: 'Non-interactive pending test message' },
      });
      assert(sendRes.status === 201, `Send expected 201, got ${sendRes.status}`);
      const msg = sendRes.body as Record<string, unknown>;
      const msgId = msg['id'] as string;
      console.log(
        `  Sent from new unknown: id=${msgId}, first_contact=${msg['first_contact']}, autonomy_allowed=${msg['autonomy_allowed']}`
      );
      assert(msg['first_contact'] === true, 'Expected first_contact=true');
      assert(msg['autonomy_allowed'] === false, 'Expected autonomy_allowed=false');

      // Check Bob's inbox for this specific message — should be delivered, not auto-read/auto-acked
      const inboxRes = await relayFetch('/inbox', { token: BOB_TOKEN });
      const messages = (inboxRes.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      const targetMsg = messages.find((m) => m['id'] === msgId) as Record<string, unknown>;
      assert(targetMsg !== undefined, 'Message not found in inbox');
      console.log(
        `  Inbox message: state=${targetMsg['state']}, read_at=${targetMsg['read_at']}, acked_at=${targetMsg['acked_at']}`
      );
      assert(
        targetMsg['state'] === 'delivered',
        `Expected delivered state, got ${targetMsg['state']}`
      );
      assert(
        targetMsg['read_at'] === null || targetMsg['read_at'] === undefined,
        'Expected read_at to be null (no auto-read)'
      );
      assert(
        targetMsg['acked_at'] === null || targetMsg['acked_at'] === undefined,
        'Expected acked_at to be null (no auto-ack)'
      );

      results.push({
        name,
        assertion: 'VAL-RELAY-013',
        passed: true,
        evidence: `Message ${msgId} from unknown sender: state=delivered, read_at=null, acked_at=null. No autonomous actions occurred.`,
      });
    } catch (e) {
      results.push({
        name,
        assertion: 'VAL-RELAY-013',
        passed: false,
        evidence: '',
        error: String(e),
      });
    }
  }

  // Test 3: Read/ack does NOT auto-approve pending contact
  {
    const name = 'Read/ack does not auto-approve pending contact';
    try {
      // Get a message from Charlie (pending contact)
      const inboxRes = await relayFetch('/inbox', { token: BOB_TOKEN });
      const messages = (inboxRes.body as Record<string, unknown>)['messages'] as Array<
        Record<string, unknown>
      >;
      const charlieMsg = messages.find(
        (m) => (m['sender_id'] as string) === 'acct_charlie_val' && m['state'] === 'delivered'
      );
      assert(charlieMsg !== undefined, 'No delivered message from Charlie found');
      const msgId = charlieMsg!['id'] as string;

      // Bob reads and acks
      await relayFetch(`/messages/${msgId}/read`, { method: 'POST', token: BOB_TOKEN });
      await relayFetch(`/messages/${msgId}/ack`, { method: 'POST', token: BOB_TOKEN });

      // Charlie should STILL be pending
      const statusRes = await relayFetch('/contacts/status', {
        method: 'POST',
        token: BOB_TOKEN,
        body: { contact_account_id: 'acct_charlie_val' },
      });
      const result = statusRes.body as Record<string, unknown>;
      console.log(
        `  After read+ack, Charlie contact status: ${result['status']}, autonomy_allowed=${result['autonomy_allowed']}`
      );
      assert(
        result['status'] === 'pending',
        `Expected pending after read/ack, got ${result['status']}`
      );
      assert(
        result['autonomy_allowed'] === false,
        'Expected autonomy_allowed=false - read/ack should NOT auto-approve'
      );

      results.push({
        name,
        assertion: 'VAL-RELAY-013',
        passed: true,
        evidence: `After Bob read+acked Charlie's message, Charlie's contact status remains pending with autonomy_allowed=false. No auto-approve on read/ack.`,
      });
    } catch (e) {
      results.push({
        name,
        assertion: 'VAL-RELAY-013',
        passed: false,
        evidence: '',
        error: String(e),
      });
    }
  }

  // Test 4: Approving transitions pending→approved and subsequent messages get autonomy
  {
    const name = 'Approving pending contact enables future autonomy';
    try {
      // Approve Charlie
      const approveRes = await relayFetch('/contacts/approve', {
        method: 'POST',
        token: BOB_TOKEN,
        body: { contact_account_id: 'acct_charlie_val' },
      });
      assert(approveRes.status === 200, `Approve expected 200, got ${approveRes.status}`);

      // Charlie now sends another message
      const sendRes = await relayFetch('/messages', {
        method: 'POST',
        token: CHARLIE_TOKEN,
        body: { recipient_id: 'acct_bob_val', body: 'Now approved Charlie message' },
      });
      assert(sendRes.status === 201, `Send expected 201, got ${sendRes.status}`);
      const msg = sendRes.body as Record<string, unknown>;
      console.log(
        `  After approval, Charlie send: first_contact=${msg['first_contact']}, autonomy_allowed=${msg['autonomy_allowed']}`
      );
      assert(msg['first_contact'] === false, 'Expected first_contact=false after approval');
      assert(msg['autonomy_allowed'] === true, 'Expected autonomy_allowed=true after approval');

      // Pending list should no longer include Charlie
      const pendingRes = await relayFetch('/contacts/pending', { token: BOB_TOKEN });
      const pendingResult = pendingRes.body as Record<string, unknown>;
      const pending = pendingResult['pending'] as string[];
      assert(
        !pending.includes('acct_charlie_val'),
        'Charlie should no longer be in pending after approval'
      );
      console.log(`  Pending contacts after Charlie approval: ${JSON.stringify(pending)}`);

      results.push({
        name,
        assertion: 'VAL-RELAY-013',
        passed: true,
        evidence: `Charlie approved: subsequent message has first_contact=false, autonomy_allowed=true. Charlie removed from pending contacts list.`,
      });
    } catch (e) {
      results.push({
        name,
        assertion: 'VAL-RELAY-013',
        passed: false,
        evidence: '',
        error: String(e),
      });
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Starting autonomy-permissions flow validation...\n');

  // Verify relay health
  const healthRes = await relayFetch('/health');
  console.log(`Relay health: ${(healthRes.body as Record<string, unknown>)['status']}`);

  await testVAL_RELAY_011();
  await testVAL_RELAY_012();
  await testVAL_RELAY_013();

  // Summary
  console.log('\n\n=== VALIDATION SUMMARY ===\n');
  const passed = results.filter((r) => r.passed);
  const failed = results.filter((r) => !r.passed);

  console.log(`Total: ${results.length}, Passed: ${passed.length}, Failed: ${failed.length}\n`);

  for (const r of results) {
    const icon = r.passed ? '✅' : '❌';
    console.log(`${icon} [${r.assertion}] ${r.name}`);
    if (r.evidence) console.log(`   Evidence: ${r.evidence}`);
    if (r.error) console.log(`   Error: ${r.error}`);
  }

  // Write flow report JSON
  const report = {
    flowId: 'autonomy-permissions-inline',
    assertions: ['VAL-RELAY-011', 'VAL-RELAY-012', 'VAL-RELAY-013'],
    results: results.map((r) => ({
      assertion: r.assertion,
      testName: r.name,
      status: r.passed ? 'pass' : 'fail',
      evidence: r.evidence,
      error: r.error,
    })),
    summary: {
      total: results.length,
      passed: passed.length,
      failed: failed.length,
    },
    toolsUsed: ['relay-api-http', 'native-token-generation'],
    frictions: [],
    blockers: [],
  };

  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    '.factory/validation/autonomy-permissions/user-testing/flows/autonomy-inline.json',
    JSON.stringify(report, null, 2) + '\n'
  );
  console.log(
    '\nFlow report written to .factory/validation/autonomy-permissions/user-testing/flows/autonomy-inline.json'
  );

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Validation failed:', err);
  process.exit(1);
});
