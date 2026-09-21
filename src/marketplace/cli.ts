import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getConfigDir } from '../identity.js';
import { loadSession } from '../auth/session.js';
import { resolveRelayBaseUrl } from '../settings.js';
import { readPackageDir, scaffoldPackageDir, validatePackage, validateSlug, writePackageDir, type AgentPackage } from './package.js';

const HELP = `Usage: mors marketplace <command>

  init [dir]              Scaffold agent.json plus skills/, tools/, context/, docs/
  publish [dir]           Publish the package directory to the relay marketplace
  search [query]          List published agent packages
  show <slug>             Show one package
  install <slug>          Download a package into this project's roster
  roster                  List locally installed packages

Options:
  --json                  Machine-readable output
  --relay-url <url>       Relay base URL (else MORS_RELAY_BASE_URL / setup)
  --project <path>        Project root for install/roster (default: cwd)
`;

interface RosterEntry {
  slug: string;
  name: string;
  summary: string;
  owner: string;
  installedAt: string;
  path: string;
}

export async function runMarketplaceCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      'relay-url': { type: 'string' },
      project: { type: 'string' },
    },
  });
  if (values.help || positionals.length === 0) {
    console.log(HELP);
    return;
  }

  const json = Boolean(values.json);
  const command = positionals[0];
  const rest = positionals.slice(1);
  const project = resolve(values.project ?? process.cwd());

  if (command === 'init') {
    const dir = resolve(rest[0] ?? join(project, 'agent-package'));
    const slug = (rest[1] ?? basenameSlug(dir)).toLowerCase();
    const pkg = scaffoldPackageDir(dir, slug);
    emit(json, { status: 'ok', dir, slug: pkg.manifest.slug });
    if (!json) console.log(`Scaffolded ${dir} (${pkg.manifest.slug})`);
    return;
  }

  if (command === 'publish') {
    const dir = resolve(rest[0] ?? project);
    const pkg = readPackageDir(dir);
    const published = await postPackage(pkg, values['relay-url']);
    emit(json, published);
    if (!json) console.log(`Published ${published.slug} as @${published.owner}`);
    return;
  }

  if (command === 'search') {
    const query = rest.join(' ').toLowerCase();
    const agents = ((await getJson('/marketplace.json', values['relay-url'])).agents ?? []) as Array<Record<string, unknown>>;
    const matches = query
      ? agents.filter((agent) => JSON.stringify(agent).toLowerCase().includes(query))
      : agents;
    emit(json, { status: 'ok', agents: matches });
    if (!json) {
      if (matches.length === 0) console.log('No packages.');
      for (const agent of matches) {
        console.log(`${agent['slug']}\t${agent['name']}\t@${agent['owner']}`);
      }
    }
    return;
  }

  if (command === 'show') {
    const slug = rest[0];
    if (!slug) throw new Error('show requires a slug.');
    const body = await getJson(`/marketplace/${encodeURIComponent(slug)}.json`, values['relay-url']);
    emit(json, body);
    if (!json) {
      console.log(`${body['name']} (${body['slug']}) @${body['owner']}`);
      console.log(String(body['summary'] ?? ''));
      console.log(`mors marketplace install ${body['slug']}`);
    }
    return;
  }

  if (command === 'install') {
    if (!rest[0]) throw new Error('install requires a slug.');
    const slug = validateSlug(rest[0]);
    const body = (await getJson(`/marketplace/${encodeURIComponent(slug)}.json`, values['relay-url'])) as {
      slug: string;
      name: string;
      summary: string;
      owner: string;
      package: AgentPackage;
    };
    const pkg = validatePackage(body.package);
    if (body.slug !== slug || pkg.manifest.slug !== slug) {
      throw new Error('Relay package slug does not match the requested slug.');
    }
    const dest = projectPath(project, '.mors', 'roster', slug);
    const previous = existsSync(dest) ? readPackageDir(dest) : undefined;
    rosterPath(project);
    for (const path of Object.keys({ ...previous?.files, ...pkg.files })) {
      if (path.startsWith('skills/')) projectPath(project, '.agents', path);
    }
    writePackageDir(dest, pkg);
    installSkills(project, previous, pkg);
    const roster = readRoster(project);
    const entry: RosterEntry = {
      slug: body.slug,
      name: body.name,
      summary: body.summary,
      owner: body.owner,
      installedAt: new Date().toISOString(),
      path: dest,
    };
    writeRoster(project, [...roster.filter((item) => item.slug !== entry.slug), entry]);
    emit(json, { status: 'installed', ...entry });
    if (!json) console.log(`Installed ${body.slug} into ${dest}`);
    return;
  }

  if (command === 'roster') {
    const roster = readRoster(project);
    emit(json, { status: 'ok', agents: roster });
    if (!json) {
      if (roster.length === 0) console.log('Roster empty. Install with: mors marketplace install <slug>');
      for (const entry of roster) console.log(`${entry.slug}\t${entry.name}\t@${entry.owner}`);
    }
    return;
  }

  throw new Error(`Unknown marketplace command "${command}".`);
}

function basenameSlug(dir: string): string {
  const name = dir.split(/[/\\]/).filter(Boolean).pop() ?? 'agent';
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
}

function rosterPath(project: string): string {
  return projectPath(project, '.mors', 'roster.json');
}

function projectPath(project: string, ...parts: string[]): string {
  const target = join(project, ...parts);
  const suffix = relative(project, target);
  if (suffix.startsWith('..') || isAbsolute(suffix)) throw new Error('Package path escapes the project.');
  for (let path = target; path !== project; path = dirname(path)) {
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`symlinks are not allowed in installation paths: ${path}`);
    }
  }
  return target;
}

function readRoster(project: string): RosterEntry[] {
  const path = rosterPath(project);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { agents?: RosterEntry[] };
    return Array.isArray(parsed.agents) ? parsed.agents : [];
  } catch {
    return [];
  }
}

function writeRoster(project: string, agents: RosterEntry[]): void {
  mkdirSync(join(project, '.mors'), { recursive: true });
  writeFileSync(rosterPath(project), `${JSON.stringify({ agents }, null, 2)}\n`);
}

function installSkills(project: string, previous: AgentPackage | undefined, pkg: AgentPackage): void {
  for (const [path, content] of Object.entries(pkg.files)) {
    if (!path.startsWith('skills/')) continue;
    const installed = projectPath(project, '.agents', path);
    mkdirSync(dirname(installed), { recursive: true });
    writeFileSync(installed, content);
  }
  for (const [path, content] of Object.entries(previous?.files ?? {})) {
    if (!path.startsWith('skills/') || path in pkg.files) continue;
    const installed = projectPath(project, '.agents', path);
    if (lstatSync(installed, { throwIfNoEntry: false })?.isFile() && readFileSync(installed, 'utf8') === content) {
      rmSync(installed);
    }
  }
}

async function getJson(path: string, relayUrl?: string): Promise<Record<string, unknown>> {
  const base = relayUrl ?? resolveRelayBaseUrl(getConfigDir());
  if (!base) throw new Error('No relay URL. Pass --relay-url or run mors setup relay.');
  const res = await fetch(new URL(path, base.endsWith('/') ? base : `${base}/`));
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(body['detail'] ?? body['error'] ?? `HTTP ${res.status}`));
  return body;
}

async function postPackage(pkg: AgentPackage, relayUrl?: string): Promise<Record<string, unknown>> {
  const configDir = getConfigDir();
  const session = loadSession(configDir);
  if (!session) throw new Error('Publishing requires login. Run mors login or mors setup relay.');
  const base = relayUrl ?? resolveRelayBaseUrl(configDir);
  if (!base) throw new Error('No relay URL. Pass --relay-url or run mors setup relay.');
  const res = await fetch(new URL('/marketplace/packages', base.endsWith('/') ? base : `${base}/`), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(pkg),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(body['detail'] ?? body['error'] ?? `HTTP ${res.status}`));
  return body;
}

function emit(json: boolean, value: unknown): void {
  if (json) console.log(JSON.stringify(value));
}
