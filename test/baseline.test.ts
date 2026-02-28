import { describe, it, expect } from "vitest";
import { run } from "../src/cli.js";

describe("mors CLI baseline", () => {
  it("prints version with --version flag", () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      run(["--version"]);
      expect(logs).toContain("mors 0.1.0");
    } finally {
      console.log = originalLog;
    }
  });

  it("prints usage with --help flag", () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      run(["--help"]);
      expect(logs.some((l) => l.includes("mors"))).toBe(true);
      expect(logs.some((l) => l.includes("Usage:"))).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });

  it("prints usage with no arguments", () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      run([]);
      expect(logs.some((l) => l.includes("Usage:"))).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });

  it("reports unknown command with non-zero exit", () => {
    const errors: string[] = [];
    const originalError = console.error;
    const originalExitCode = process.exitCode;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      run(["nonexistent"]);
      expect(errors.some((e) => e.includes("Unknown command"))).toBe(true);
      expect(process.exitCode).toBe(1);
    } finally {
      console.error = originalError;
      process.exitCode = originalExitCode;
    }
  });
});
