import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthPrincipal } from '../relay/auth-middleware.js';
import type { AccountStore } from '../relay/account-store.js';
import { MarketplaceStore } from './store.js';
import { validateManifest, validatePackage } from './package.js';
import { renderFile, renderIndex, renderNew, renderNotFound, renderProfile } from './html.js';

export interface MarketplaceHttp {
  store: MarketplaceStore;
  accountStore?: AccountStore;
  principal?: AuthPrincipal | null;
}

export function isMarketplaceGet(path: string): boolean {
  return path === '/' || path === '/marketplace' || path === '/marketplace.json' || path === '/marketplace/new' || path.startsWith('/marketplace/');
}

export function handleMarketplaceGet(
  req: IncomingMessage,
  res: ServerResponse,
  http: MarketplaceHttp
): boolean {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;

  if (path === '/' || path === '/marketplace') {
    sendHtml(res, 200, renderIndex(http.store.list(), url.searchParams.get('q') ?? ''));
    return true;
  }
  if (path === '/marketplace.json') {
    sendJson(res, 200, { agents: http.store.list().map(publicAgent) });
    return true;
  }
  if (path === '/marketplace/new') {
    sendHtml(res, 200, renderNew());
    return true;
  }
  if (path === '/marketplace/packages') {
    sendJson(res, 404, { error: 'not_found' });
    return true;
  }
  const fileMatch = /^\/marketplace\/([^/]+)\/file$/.exec(path);
  if (fileMatch) {
    const agent = loadAgent(http.store, decodeURIComponent(fileMatch[1]));
    if (!agent) {
      sendHtml(res, 404, renderNotFound());
      return true;
    }
    sendHtml(res, 200, renderFile(agent, url.searchParams.get('path') ?? ''));
    return true;
  }
  const jsonMatch = /^\/marketplace\/([^/]+)\.json$/.exec(path);
  if (jsonMatch) {
    const agent = loadAgent(http.store, decodeURIComponent(jsonMatch[1]));
    if (!agent) {
      sendJson(res, 404, { error: 'not_found' });
      return true;
    }
    sendJson(res, 200, publicAgent(agent));
    return true;
  }
  const showMatch = /^\/marketplace\/([^/]+)$/.exec(path);
  if (showMatch) {
    const agent = loadAgent(http.store, decodeURIComponent(showMatch[1]));
    if (!agent) {
      sendHtml(res, 404, renderNotFound());
      return true;
    }
    sendHtml(res, 200, renderProfile(agent));
    return true;
  }
  return false;
}

export async function handleMarketplaceWrite(
  req: IncomingMessage,
  res: ServerResponse,
  http: MarketplaceHttp
): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0];
  const method = req.method ?? 'GET';
  if (path !== '/marketplace/packages' || method !== 'POST') return false;

  const principal = http.principal;
  if (!principal) {
    sendJson(res, 401, { error: 'not_authenticated', detail: 'Publishing requires a mors session token.' });
    return true;
  }

  const body = await readJson(req);
  if (!body) {
    sendJson(res, 400, { error: 'invalid_body', detail: 'JSON body required.' });
    return true;
  }

  try {
    const filesRaw = body['files'];
    if (filesRaw !== undefined && (typeof filesRaw !== 'object' || filesRaw === null || Array.isArray(filesRaw))) {
      throw new Error('files must be an object of path → text.');
    }
    const pkg = validatePackage({
      manifest: validateManifest(body['manifest']),
      files: (filesRaw ?? {}) as Record<string, string>,
    });
    const profile = http.accountStore?.getByAccountId(principal.accountId);
    const handle = profile?.handle ?? principal.accountId;
    const published = http.store.publish(pkg, { accountId: principal.accountId, handle });
    sendJson(res, 201, publicAgent(published));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes('owned by') ? 409 : 400;
    sendJson(res, status, { error: 'invalid_package', detail: message });
  }
  return true;
}

function loadAgent(store: MarketplaceStore, slug: string) {
  try {
    return store.get(slug);
  } catch {
    return null;
  }
}

function publicAgent(agent: ReturnType<MarketplaceStore['list']>[number]) {
  return {
    slug: agent.manifest.slug,
    name: agent.manifest.name,
    summary: agent.manifest.summary,
    specialties: agent.manifest.specialties,
    version: agent.manifest.version,
    owner: agent.ownerHandle,
    files: Object.keys(agent.files).sort(),
    package: { manifest: agent.manifest, files: agent.files },
    published_at: agent.publishedAt,
    updated_at: agent.updatedAt,
  };
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 1_048_576) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}
