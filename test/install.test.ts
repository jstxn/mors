import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

describe("distribution metadata", () => {
  it("package is not marked private", () => {
    expect(pkg.private).not.toBe(true);
  });

  it("package has bin entry pointing to dist/index.js", () => {
    expect(pkg.bin).toBeDefined();
    expect(pkg.bin.mors).toBe("./dist/index.js");
  });

  it("package has files field including dist", () => {
    expect(pkg.files).toBeDefined();
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files).toContain("dist");
  });

  it("package has prepare script that builds", () => {
    expect(pkg.scripts).toBeDefined();
    expect(pkg.scripts.prepare).toBeDefined();
    expect(pkg.scripts.prepare).toContain("build");
  });

  it("package has engines constraint for node >=20", () => {
    expect(pkg.engines).toBeDefined();
    expect(pkg.engines.node).toBe(">=20");
  });

  it("package type is module", () => {
    expect(pkg.type).toBe("module");
  });
});

describe("build output", () => {
  it("dist/index.js exists after build", () => {
    // Ensure build has been run
    execSync("npm run build", { cwd: ROOT, stdio: "pipe" });
    expect(existsSync(join(ROOT, "dist", "index.js"))).toBe(true);
  });

  it("dist/index.js starts with shebang", () => {
    const content = readFileSync(join(ROOT, "dist", "index.js"), "utf8");
    expect(content.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("dist/index.js is executable", () => {
    const stat = statSync(join(ROOT, "dist", "index.js"));
    // Check owner execute bit (0o100)
    const ownerExec = (stat.mode & 0o100) !== 0;
    expect(ownerExec).toBe(true);
  });

  it("dist/cli.js exists after build", () => {
    expect(existsSync(join(ROOT, "dist", "cli.js"))).toBe(true);
  });
});

describe("npm pack includes correct files", () => {
  it("npm pack --dry-run lists dist files and package.json", () => {
    const output = execSync("npm pack --dry-run --json 2>/dev/null", {
      cwd: ROOT,
      encoding: "utf8",
    });
    const packInfo = JSON.parse(output);
    expect(Array.isArray(packInfo)).toBe(true);
    const files = packInfo[0].files.map(
      (f: { path: string }) => f.path,
    );

    // Must include key distribution files
    expect(files).toContain("package.json");
    expect(files.some((f: string) => f.startsWith("dist/"))).toBe(true);
    expect(files.some((f: string) => f === "dist/index.js")).toBe(true);
    expect(files.some((f: string) => f === "dist/cli.js")).toBe(true);

    // Must NOT include source or test files
    expect(files.some((f: string) => f.startsWith("src/"))).toBe(false);
    expect(files.some((f: string) => f.startsWith("test/"))).toBe(false);
    expect(
      files.some((f: string) => f === "tsconfig.json"),
    ).toBe(false);
  });
});

describe("prepare script lifecycle", () => {
  it("prepare script produces runnable dist/index.js", () => {
    // Running prepare should build the project
    execSync("npm run prepare", { cwd: ROOT, stdio: "pipe" });
    expect(existsSync(join(ROOT, "dist", "index.js"))).toBe(true);

    // The built entry should be runnable and output version info
    const result = execSync("node dist/index.js --version", {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, MORS_CONFIG_DIR: "/tmp/mors-install-test-noop" },
    });
    // Should output the version from package.json
    expect(result.trim()).toContain(pkg.version);
  });
});
