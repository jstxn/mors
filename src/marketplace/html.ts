import { PACKAGE_DIRS, type PublishedAgent } from './package.js';

function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 16px/1.45 ui-sans-serif, system-ui, sans-serif; background: #101210; color: #e7eadf; }
    a { color: #9be7a8; }
    header, main, footer { max-width: 920px; margin: 0 auto; padding: 1.25rem 1.25rem; }
    header { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; border-bottom: 1px solid #2a2f2a; }
    header a.brand { color: inherit; text-decoration: none; font-weight: 650; letter-spacing: .02em; }
    .muted { color: #9aa193; }
    .grid { display: grid; gap: 1rem; }
    @media (min-width: 720px) { .grid.cards { grid-template-columns: 1fr 1fr; } }
    .card { display: block; border: 1px solid #2d332d; background: #171a17; border-radius: 12px; padding: 1rem 1.1rem; text-decoration: none; color: inherit; }
    .card:hover { border-color: #4a7a52; }
    h1, h2 { font-weight: 650; letter-spacing: -.02em; }
    .pill { display: inline-block; margin: 0 .35rem .35rem 0; padding: .15rem .5rem; border-radius: 999px; background: #243024; color: #cfe8d2; font-size: .8rem; }
    pre, textarea, input, button { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
    pre { overflow: auto; background: #0c0e0c; border: 1px solid #2d332d; padding: 1rem; border-radius: 10px; }
    label { display: block; margin: .8rem 0 .3rem; font-size: .9rem; color: #c5cbb8; }
    input, textarea { width: 100%; background: #0c0e0c; color: inherit; border: 1px solid #343b34; border-radius: 8px; padding: .55rem .7rem; }
    button, .btn { display: inline-block; margin-top: 1rem; background: #9be7a8; color: #102012; border: 0; border-radius: 8px; padding: .55rem .9rem; font-weight: 650; cursor: pointer; text-decoration: none; }
    .files a { display: block; padding: .25rem 0; }
    .empty { border: 1px dashed #3a403a; border-radius: 12px; padding: 1.5rem; }
  </style>
</head>
<body>
  <header>
    <a class="brand" href="/marketplace">mors marketplace</a>
    <nav><a href="/marketplace/new">Publish</a></nav>
  </header>
  <main>${body}</main>
  <footer class="muted">Agent packages are skills, tools, context, and docs. Installing copies them into your project roster. It does not run someone else’s process.</footer>
</body>
</html>`;
}

export function renderIndex(agents: PublishedAgent[], query = ''): string {
  const q = query.trim().toLowerCase();
  const matches = q
    ? agents.filter((agent) => {
        const hay = [agent.manifest.slug, agent.manifest.name, agent.manifest.summary, agent.ownerHandle, ...agent.manifest.specialties].join(' ').toLowerCase();
        return hay.includes(q);
      })
    : agents;
  const cards = matches.length
    ? `<div class="grid cards">${matches.map((agent) => `
      <a class="card" href="/marketplace/${esc(agent.manifest.slug)}">
        <strong>${esc(agent.manifest.name)}</strong>
        <div class="muted">@${esc(agent.ownerHandle)} · ${esc(agent.manifest.slug)}</div>
        <p>${esc(agent.manifest.summary)}</p>
        <div>${agent.manifest.specialties.map((s) => `<span class="pill">${esc(s)}</span>`).join('')}</div>
      </a>`).join('')}</div>`
    : `<div class="empty"><p>No agent packages yet.</p><p class="muted">Publish one with <code>mors marketplace publish</code> or the form.</p></div>`;
  return layout('mors marketplace', `
    <h1>Agent packages</h1>
    <p class="muted">Browse specialists other engineers published. Install a package to put its skills, tools, context, and docs on your local roster.</p>
    <form method="get" action="/marketplace">
      <label for="q">Search</label>
      <input id="q" name="q" value="${esc(query)}" placeholder="sqlcipher, review, linear…">
    </form>
    ${cards}
  `);
}

export function renderProfile(agent: PublishedAgent): string {
  const files = Object.keys(agent.files).sort();
  const groups = PACKAGE_DIRS.map((dir) => {
    const listed = files.filter((path) => path.startsWith(`${dir}/`));
    if (listed.length === 0) return '';
    return `<h2>${dir}</h2><div class="files">${listed.map((path) =>
      `<a href="/marketplace/${esc(agent.manifest.slug)}/file?path=${encodeURIComponent(path)}">${esc(path)}</a>`
    ).join('')}</div>`;
  }).join('');
  return layout(agent.manifest.name, `
    <p class="muted"><a href="/marketplace">← catalog</a></p>
    <h1>${esc(agent.manifest.name)}</h1>
    <p class="muted">@${esc(agent.ownerHandle)} · <code>${esc(agent.manifest.slug)}</code> · v${esc(agent.manifest.version)}</p>
    <p>${esc(agent.manifest.summary)}</p>
    <div>${agent.manifest.specialties.map((s) => `<span class="pill">${esc(s)}</span>`).join('')}</div>
    <h2>Use this agent</h2>
    <pre>mors marketplace install ${esc(agent.manifest.slug)}</pre>
    <p class="muted">Copies the package into <code>.mors/roster/${esc(agent.manifest.slug)}</code> and installs skills under <code>.agents/skills/</code>.</p>
    ${groups || '<p class="muted">This package has no extra files yet.</p>'}
  `);
}

export function renderFile(agent: PublishedAgent, path: string): string {
  const content = agent.files[path];
  if (content === undefined) return renderNotFound();
  return layout(`${path} · ${agent.manifest.name}`, `
    <p class="muted"><a href="/marketplace/${esc(agent.manifest.slug)}">← ${esc(agent.manifest.name)}</a></p>
    <h1>${esc(path)}</h1>
    <pre>${esc(content)}</pre>
  `);
}

export function renderNew(): string {
  return layout('Publish an agent', `
    <h1>Publish an agent package</h1>
    <p class="muted">Paste a session token from <code>mors status</code>. Prefer the CLI: <code>mors marketplace init ./my-agent && mors marketplace publish ./my-agent</code>.</p>
    <form id="pub">
      <label for="token">Session token</label>
      <input id="token" name="token" type="password" required autocomplete="off">
      <label for="slug">Slug</label>
      <input id="slug" name="slug" required placeholder="sqlcipher-reviewer" pattern="[a-z0-9]([a-z0-9]|-){1,46}[a-z0-9]">
      <label for="name">Name</label>
      <input id="name" name="name" required>
      <label for="summary">Summary</label>
      <textarea id="summary" name="summary" rows="3" required></textarea>
      <label for="specialties">Specialties (comma separated)</label>
      <input id="specialties" name="specialties" placeholder="sqlcipher, review">
      <label for="skill">Skill (SKILL.md)</label>
      <textarea id="skill" name="skill" rows="10" placeholder="---&#10;name: example&#10;description: …&#10;---&#10;"></textarea>
      <label for="docs">Docs (README.md)</label>
      <textarea id="docs" name="docs" rows="6"></textarea>
      <button type="submit">Publish</button>
      <p id="out" class="muted"></p>
    </form>
    <script>
      const form = document.getElementById('pub');
      const out = document.getElementById('out');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData(form);
        const slug = String(data.get('slug') || '').trim();
        const skill = String(data.get('skill') || '');
        const docs = String(data.get('docs') || '');
        const files = {};
        if (skill.trim()) files['skills/' + slug + '/SKILL.md'] = skill;
        if (docs.trim()) files['docs/README.md'] = docs;
        const body = {
          manifest: {
            schema: 'mors.agent-package.v1',
            slug,
            name: String(data.get('name') || '').trim(),
            summary: String(data.get('summary') || '').trim(),
            specialties: String(data.get('specialties') || '').split(',').map((s) => s.trim()).filter(Boolean),
            version: '1.0.0'
          },
          files
        };
        out.textContent = 'Publishing…';
        const res = await fetch('/marketplace/packages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + String(data.get('token') || '')
          },
          body: JSON.stringify(body)
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          out.textContent = json.detail || json.error || ('HTTP ' + res.status);
          return;
        }
        location.href = '/marketplace/' + encodeURIComponent(slug);
      });
    </script>
  `);
}

export function renderNotFound(): string {
  return layout('Not found', `<h1>Agent not found</h1><p class="muted"><a href="/marketplace">Back to catalog</a></p>`);
}
