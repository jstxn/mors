import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const PACKAGE_SCHEMA = 'mors.agent-package.v1';
export const PACKAGE_DIRS = ['skills', 'tools', 'context', 'docs'] as const;
export type PackageDir = (typeof PACKAGE_DIRS)[number];

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
const ALLOWED_EXT = new Set(['.md', '.json', '.txt', '.yml', '.yaml', '.toml']);
const MAX_FILES = 40;
const MAX_FILE_BYTES = 200_000;
const MAX_TOTAL_BYTES = 1_000_000;

export interface AgentManifest {
  schema: typeof PACKAGE_SCHEMA;
  slug: string;
  name: string;
  summary: string;
  specialties: string[];
  version: string;
}

export interface AgentPackage {
  manifest: AgentManifest;
  files: Record<string, string>;
}

export interface PublishedAgent extends AgentPackage {
  ownerHandle: string;
  ownerAccountId: string;
  publishedAt: string;
  updatedAt: string;
}

export function validateSlug(slug: string): string {
  const value = slug.trim().toLowerCase();
  if (!SLUG_RE.test(value)) {
    throw new Error(
      'slug must be 3–48 characters, lowercase letters, numbers, and hyphens, and cannot start or end with a hyphen.'
    );
  }
  return value;
}

export function validateManifest(raw: unknown): AgentManifest {
  if (!raw || typeof raw !== 'object') throw new Error('agent.json must be an object.');
  const value = raw as Record<string, unknown>;
  if (value['schema'] !== PACKAGE_SCHEMA) {
    throw new Error(`agent.json schema must be "${PACKAGE_SCHEMA}".`);
  }
  const slug = typeof value['slug'] === 'string' ? validateSlug(value['slug']) : '';
  if (!slug) throw new Error('agent.json slug is required.');
  const name = typeof value['name'] === 'string' ? value['name'].trim() : '';
  if (name.length < 2 || name.length > 80) throw new Error('agent.json name must be 2–80 characters.');
  const summary = typeof value['summary'] === 'string' ? value['summary'].trim() : '';
  if (summary.length < 8 || summary.length > 280) {
    throw new Error('agent.json summary must be 8–280 characters.');
  }
  const specialties = Array.isArray(value['specialties'])
    ? value['specialties'].filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
  const version = typeof value['version'] === 'string' && value['version'].trim() ? value['version'].trim() : '1.0.0';
  return { schema: PACKAGE_SCHEMA, slug, name, summary, specialties, version };
}

export function sanitizePackagePath(input: string): string {
  const normalized = input.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || normalized.startsWith('/')) {
    throw new Error(`illegal package path: ${input}`);
  }
  const [root, ...rest] = normalized.split('/');
  if (!PACKAGE_DIRS.includes(root as PackageDir) || rest.length === 0) {
    throw new Error(`files must live under ${PACKAGE_DIRS.join(', ')}: ${input}`);
  }
  const ext = `.${normalized.split('.').pop() ?? ''}`;
  if (!ALLOWED_EXT.has(ext.toLowerCase())) {
    throw new Error(`file type not allowed (${[...ALLOWED_EXT].join(', ')}): ${input}`);
  }
  return normalized;
}

export function validatePackage(pkg: AgentPackage): AgentPackage {
  const manifest = validateManifest(pkg.manifest);
  const files: Record<string, string> = {};
  const entries = Object.entries(pkg.files ?? {});
  if (entries.length > MAX_FILES) throw new Error(`too many files (max ${MAX_FILES}).`);
  let total = 0;
  for (const [rawPath, content] of entries) {
    if (typeof content !== 'string') throw new Error(`file ${rawPath} must be text.`);
    const path = sanitizePackagePath(rawPath);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_FILE_BYTES) throw new Error(`${path} exceeds ${MAX_FILE_BYTES} bytes.`);
    total += bytes;
    if (total > MAX_TOTAL_BYTES) throw new Error(`package exceeds ${MAX_TOTAL_BYTES} bytes.`);
    files[path] = content;
  }
  return { manifest, files };
}

export function readPackageDir(root: string): AgentPackage {
  packageStat(root);
  const manifestPath = join(root, 'agent.json');
  if (!packageStat(manifestPath)?.isFile()) throw new Error(`missing or non-regular file: ${manifestPath}`);
  const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const files: Record<string, string> = {};
  for (const dir of PACKAGE_DIRS) {
    collectFiles(join(root, dir), dir, files);
  }
  return validatePackage({ manifest, files });
}

export function writePackageDir(root: string, pkg: AgentPackage): void {
  const valid = validatePackage(pkg);
  packageStat(root);
  mkdirSync(root, { recursive: true });
  const staging = mkdtempSync(join(root, '.package-'));
  const next = join(staging, 'next');
  const previous = join(staging, 'previous');
  const entries = ['agent.json', ...PACKAGE_DIRS];
  const installed: string[] = [];
  let cleanup = true;
  try {
    mkdirSync(next);
    mkdirSync(previous);
    writeFileSync(join(next, 'agent.json'), `${JSON.stringify(valid.manifest, null, 2)}\n`);
    for (const dir of PACKAGE_DIRS) mkdirSync(join(next, dir));
    for (const [path, content] of Object.entries(valid.files)) {
      const abs = join(next, ...path.split('/'));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    try {
      for (const name of entries) {
        const target = join(root, name);
        if (lstatSync(target, { throwIfNoEntry: false })) renameSync(target, join(previous, name));
        renameSync(join(next, name), target);
        installed.push(name);
      }
    } catch (error) {
      // Keep the backup if rollback itself fails, so recovery cannot delete old data.
      cleanup = false;
      for (const name of [...entries].reverse()) {
        if (installed.includes(name)) rmSync(join(root, name), { recursive: true, force: true });
        if (lstatSync(join(previous, name), { throwIfNoEntry: false })) {
          renameSync(join(previous, name), join(root, name));
        }
      }
      cleanup = true;
      throw error;
    }
  } finally {
    if (cleanup) rmSync(staging, { recursive: true, force: true });
  }
}

export function scaffoldPackageDir(root: string, slug: string): AgentPackage {
  if (['agent.json', ...PACKAGE_DIRS].some(name => lstatSync(join(root, name), { throwIfNoEntry: false }))) {
    throw new Error(`refusing to overwrite existing package content in ${root}`);
  }
  const manifest: AgentManifest = {
    schema: PACKAGE_SCHEMA,
    slug: validateSlug(slug),
    name: slug.replace(/-/g, ' '),
    summary: `Specialist agent package for ${slug.replace(/-/g, ' ')}.`,
    specialties: [],
    version: '1.0.0',
  };
  const files = {
    'docs/README.md': `# ${manifest.name}\n\nDescribe what this agent is for, what it will not do, and how to use it.\n`,
    [`skills/${manifest.slug}/SKILL.md`]: `---\nname: ${slug}\ndescription: Replace this with a real skill.\n---\n\n# ${manifest.name}\n\nWrite the skill the consuming agent's runtime should follow.\n`,
  };
  const pkg = { manifest, files };
  writePackageDir(root, pkg);
  return pkg;
}

function collectFiles(absDir: string, prefix: string, files: Record<string, string>): void {
  if (!packageStat(absDir)) return;
  const walk = (dir: string, relPrefix: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = `${relPrefix}/${name}`;
      const stat = packageStat(abs);
      if (stat?.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!stat?.isFile()) throw new Error(`package entry must be a regular file: ${abs}`);
      files[sanitizePackagePath(rel)] = readFileSync(abs, 'utf8');
    }
  };
  walk(absDir, prefix);
}

function packageStat(path: string) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) throw new Error(`symlinks are not allowed in agent packages: ${path}`);
  return stat;
}
