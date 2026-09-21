import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentPackage,
  type PublishedAgent,
  readPackageDir,
  validatePackage,
  validateSlug,
  writePackageDir,
} from './package.js';

export class MarketplaceStore {
  private readonly memory = new Map<string, PublishedAgent>();

  constructor(private readonly root?: string) {}

  list(): PublishedAgent[] {
    const agents: PublishedAgent[] = [];
    for (const slug of this.slugs()) {
      try {
        const entry = this.get(slug);
        if (entry) agents.push(entry);
      } catch {
        // skip corrupt listings
      }
    }
    return agents.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  }

  get(slug: string): PublishedAgent | null {
    const id = validateSlug(slug);
    if (this.root) {
      const dir = join(this.root, id);
      const metaPath = join(dir, 'meta.json');
      if (!existsSync(metaPath)) return null;
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Omit<PublishedAgent, 'manifest' | 'files'>;
      const packed = readPackageDir(dir);
      return { ...meta, ...packed };
    }
    return this.memory.get(id) ?? null;
  }

  publish(pkg: AgentPackage, owner: { accountId: string; handle: string }): PublishedAgent {
    const valid = validatePackage(pkg);
    const existing = this.safeGet(valid.manifest.slug);
    if (existing && existing.ownerAccountId !== owner.accountId) {
      throw new Error(`slug "${valid.manifest.slug}" is owned by @${existing.ownerHandle}.`);
    }
    const now = new Date().toISOString();
    const published: PublishedAgent = {
      ...valid,
      ownerHandle: owner.handle,
      ownerAccountId: owner.accountId,
      publishedAt: existing?.publishedAt ?? now,
      updatedAt: now,
    };
    this.write(published);
    return published;
  }

  remove(slug: string, accountId: string): boolean {
    const existing = this.get(slug);
    if (!existing) return false;
    if (existing.ownerAccountId !== accountId) {
      throw new Error('only the owner can unpublish this agent.');
    }
    if (this.root) rmSync(join(this.root, existing.manifest.slug), { recursive: true, force: true });
    else this.memory.delete(existing.manifest.slug);
    return true;
  }

  private safeGet(slug: string): PublishedAgent | null {
    try {
      return this.get(slug);
    } catch {
      return null;
    }
  }

  private slugs(): string[] {
    if (!this.root) return [...this.memory.keys()];
    if (!existsSync(this.root)) return [];
    const root = this.root;
    return readdirSync(root).filter((name) => existsSync(join(root, name, 'meta.json')));
  }

  private write(entry: PublishedAgent): void {
    if (!this.root) {
      this.memory.set(entry.manifest.slug, entry);
      return;
    }
    mkdirSync(this.root, { recursive: true });
    const dir = join(this.root, entry.manifest.slug);
    writePackageDir(dir, entry);
    writeFileSync(
      join(dir, 'meta.json'),
      `${JSON.stringify({
        ownerHandle: entry.ownerHandle,
        ownerAccountId: entry.ownerAccountId,
        publishedAt: entry.publishedAt,
        updatedAt: entry.updatedAt,
      }, null, 2)}\n`
    );
  }
}
