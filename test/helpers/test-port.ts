/**
 * Shared test helper for OS-assigned ephemeral port allocation.
 *
 * Returns port 0, which tells the OS kernel to assign a free ephemeral
 * port when the server binds. After server.start(), the actual port is
 * available via server.port.
 *
 * This eliminates EADDRINUSE flakiness in relay integration tests caused
 * by random port selection collisions under concurrent test execution.
 */

/**
 * Returns 0 (OS-assigned ephemeral port).
 * After calling server.start(), use server.port to get the actual bound port.
 */
export function getTestPort(): number {
  return 0;
}
