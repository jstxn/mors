import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SPOOL_SCHEMA, } from './types.js';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAILDIR_ZONES = ['tmp', 'new', 'cur'];
const MAILBOXES = ['outbox', 'inbox', 'control', 'failed'];
export class MaildirSpoolError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MaildirSpoolError';
    }
}
export class MaildirEntryError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MaildirEntryError';
    }
}
export class MaildirSpool {
    root;
    agentId;
    agentRoot;
    maxEntryBytes;
    constructor(options) {
        if (!options.root.trim()) {
            throw new MaildirSpoolError('Spool root is required.');
        }
        if (!options.agentId.trim()) {
            throw new MaildirSpoolError('Spool agent ID is required.');
        }
        assertMaildirName(options.agentId, 'spool agent ID');
        this.root = options.root;
        this.agentId = options.agentId;
        this.agentRoot = join(options.root, 'agents', options.agentId);
        this.maxEntryBytes = options.maxEntryBytes ?? 1024 * 1024;
    }
    init() {
        mkdirOwnerOnly(this.root);
        mkdirOwnerOnly(join(this.root, 'agents'));
        mkdirOwnerOnly(this.agentRoot);
        for (const mailbox of MAILBOXES) {
            for (const zone of MAILDIR_ZONES) {
                mkdirOwnerOnly(this.mailboxDir(mailbox, zone));
            }
        }
    }
    mailboxDir(mailbox, zone) {
        return join(this.agentRoot, mailbox, zone);
    }
    listNew(mailbox) {
        const dir = this.mailboxDir(mailbox, 'new');
        if (!existsSync(dir))
            return [];
        return readdirSync(dir)
            .sort()
            .map((name) => {
            assertMaildirName(name);
            return { mailbox, zone: 'new', name, path: join(dir, name) };
        });
    }
    readJson(entry) {
        const stat = lstatSync(entry.path);
        if (!stat.isFile()) {
            throw new MaildirEntryError(`Spool entry is not a regular file: ${entry.name}`);
        }
        if (stat.size > this.maxEntryBytes) {
            throw new MaildirEntryError(`Spool entry exceeds max size (${this.maxEntryBytes} bytes): ${entry.name}`);
        }
        const raw = readFileSync(entry.path, 'utf8');
        try {
            return JSON.parse(raw);
        }
        catch {
            throw new MaildirEntryError(`Spool entry is not valid JSON: ${entry.name}`);
        }
    }
    writeJson(mailbox, value, options = {}) {
        this.init();
        const name = options.name ?? `${Date.now()}.${process.pid}.${randomUUID()}.json`;
        assertMaildirName(name);
        const tmpPath = join(this.mailboxDir(mailbox, 'tmp'), name);
        const newPath = join(this.mailboxDir(mailbox, 'new'), name);
        const data = JSON.stringify(value, null, 2) + '\n';
        const fd = openSync(tmpPath, 'wx', FILE_MODE);
        try {
            writeFileSync(fd, data, 'utf8');
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        chmodSync(tmpPath, FILE_MODE);
        renameSync(tmpPath, newPath);
        return { mailbox, zone: 'new', name, path: newPath };
    }
    moveToCur(entry) {
        const curPath = join(this.mailboxDir(entry.mailbox, 'cur'), entry.name);
        renameSync(entry.path, curPath);
        return { ...entry, zone: 'cur', path: curPath };
    }
    moveToFailed(entry, reason) {
        const failedName = `${entry.mailbox}-${entry.name}`;
        assertMaildirName(failedName);
        const failedPath = join(this.mailboxDir('failed', 'new'), failedName);
        const errorPath = `${failedPath}.error.json`;
        renameSync(entry.path, failedPath);
        writeFileSync(errorPath, JSON.stringify({
            schema: SPOOL_SCHEMA,
            kind: 'spool_error',
            source_mailbox: entry.mailbox,
            source_name: entry.name,
            error: reason,
        }, null, 2) + '\n', { mode: FILE_MODE });
        chmodSync(errorPath, FILE_MODE);
        return { mailbox: 'failed', zone: 'new', name: failedName, path: failedPath };
    }
    materializeInboxMessage(message) {
        const name = `${message.id}.json`;
        assertMaildirName(name);
        if (this.hasEntry('inbox', name)) {
            return null;
        }
        const materialized = {
            schema: SPOOL_SCHEMA,
            kind: 'relay_message',
            ...message,
        };
        return this.writeJson('inbox', materialized, { name });
    }
    hasEntry(mailbox, name) {
        assertMaildirName(name);
        return (existsSync(join(this.mailboxDir(mailbox, 'new'), name)) ||
            existsSync(join(this.mailboxDir(mailbox, 'cur'), name)));
    }
}
export function assertMaildirName(name, label = 'Maildir entry name') {
    if (!name || name === '.' || name === '..' || basename(name) !== name || name.includes('\0')) {
        throw new MaildirSpoolError(`Invalid ${label}: ${JSON.stringify(name)}`);
    }
}
export function relayMessageToSpoolMessage(message) {
    return {
        schema: SPOOL_SCHEMA,
        kind: 'relay_message',
        ...message,
    };
}
function mkdirOwnerOnly(path) {
    const existed = existsSync(path);
    mkdirSync(path, { recursive: true, mode: DIR_MODE });
    const stat = statSync(path);
    if (!stat.isDirectory()) {
        throw new MaildirSpoolError(`Spool path is not a directory: ${path}`);
    }
    if (!existed) {
        chmodSync(path, DIR_MODE);
    }
}
//# sourceMappingURL=maildir.js.map