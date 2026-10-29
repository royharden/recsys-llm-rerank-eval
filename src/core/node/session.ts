// Node-only authentication. Provider secrets never enter this process or session file.
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { createPublicSupabase, type PublicSupabaseConfig } from '../../lib/supabase.ts';

export const CLI_SESSION_FILE = '.recsys-session.json';
const TokensSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1) }).strict();
const execute = promisify(execFile);
export function cliPublicConfig(env: Record<string, string | undefined> = process.env): PublicSupabaseConfig {
  const url = env.SUPABASE_URL?.trim(); const anonKey = env.SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) throw new Error('Set CLI SUPABASE_URL and SUPABASE_ANON_KEY (public values).');
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Invalid public database URL.');
  return { url: parsed.href.replace(/\/$/, ''), anonKey };
}
export function createCliSupabase(config: PublicSupabaseConfig): SupabaseClient {
  const client = createPublicSupabase(config, { persistSession: false, autoRefreshToken: false });
  if (!client) throw new Error('CLI public configuration required');
  return client;
}
async function restrictWindowsFile(file: string): Promise<void> {
  // Numeric SID avoids locale/domain quoting. execFile supplies literal arguments, with no shell.
  const { stdout } = await execute('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
  const sid = stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new Error('Cannot identify the current Windows account to restrict session storage.');
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$acl = Get-Acl -LiteralPath $env:RECSYS_SESSION_ACL_PATH',
    '$acl.SetAccessRuleProtection($true, $false)',
    'foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }',
    '$identity = [System.Security.Principal.SecurityIdentifier]::new($env:RECSYS_SESSION_ACL_SID)',
    '$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, "FullControl", "Allow")',
    '$acl.AddAccessRule($rule)',
    'Set-Acl -LiteralPath $env:RECSYS_SESSION_ACL_PATH -AclObject $acl',
  ].join('\n');
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, env: { ...process.env, RECSYS_SESSION_ACL_PATH: file, RECSYS_SESSION_ACL_SID: sid } });
}
async function assertRegular(file: string): Promise<boolean> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Session storage must be a regular unlinked file.');
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export async function saveCliSession(session: { access_token: string; refresh_token: string }, file = CLI_SESSION_FILE): Promise<void> {
  const tokens = TokensSchema.parse({ access_token: session.access_token, refresh_token: session.refresh_token });
  const absolute = path.resolve(file);
  await assertRegular(absolute);
  const handle = await open(absolute, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error('Unsafe session storage.');
    await handle.chmod(0o600);
    if (process.platform === 'win32') await restrictWindowsFile(absolute);
    // Restrict access before any credential bytes are written.
    await handle.truncate(0);
    await handle.writeFile(`${JSON.stringify(tokens)}\n`, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
}
export async function restoreCliSession(client: SupabaseClient, file = CLI_SESSION_FILE): Promise<void> {
  const absolute = path.resolve(file);
  if (!await assertRegular(absolute)) throw new Error('No CLI session. Run npm run eval -- login.');
  const info = await lstat(absolute);
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('Session permissions must be 0600. Log in again.');
  if (process.platform === 'win32') await restrictWindowsFile(absolute);
  const tokens = TokensSchema.parse(JSON.parse(await readFile(absolute, 'utf8')));
  const { data, error } = await client.auth.setSession(tokens);
  if (error || !data.session) throw new Error('CLI session expired. Run npm run eval -- login again.');
  await saveCliSession(data.session, absolute);
}
/** Interactive-only; piped passwords and command-line password arguments are deliberately unsupported. */
export async function promptPassword(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Login requires an interactive terminal (password is never echoed).');
  const input = process.stdin;
  const wasRaw = input.isRaw;
  process.stdout.write('Password: ');
  input.setRawMode(true); input.resume();
  return new Promise((resolve, reject) => {
    let password = '';
    const cleanup = (): void => {
      input.off('data', read); input.setRawMode(wasRaw); input.pause(); process.stdout.write('\n');
    };
    const read = (chunk: Buffer): void => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') { cleanup(); reject(new Error('Login cancelled.')); return; }
        if (character === '\r' || character === '\n') { cleanup(); resolve(password); return; }
        if (character === '\u007f' || character === '\b') password = password.slice(0, -1);
        else if (character >= ' ' && password.length < 4096) password += character;
      }
    };
    input.on('data', read);
  });
}
export async function loginCli(client: SupabaseClient, file = CLI_SESSION_FILE): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Login requires an interactive terminal.');
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  let email: string;
  try { email = (await reader.question('Email: ')).trim(); } finally { reader.close(); }
  const password = await promptPassword();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error('Sign-in failed. Check the account and try again.');
  await saveCliSession(data.session, file);
}
export async function logoutCli(file = CLI_SESSION_FILE): Promise<void> {
  const absolute = path.resolve(file);
  if (await assertRegular(absolute)) await unlink(absolute);
}
/** Save rotated tokens before exit even if the runner failed. No background token loop keeps the CLI alive. */
export async function checkpointCliSession(client: SupabaseClient, file = CLI_SESSION_FILE): Promise<void> {
  const { data, error } = await client.auth.getSession();
  if (error) throw new Error('Could not checkpoint CLI session.');
  if (data.session) await saveCliSession(data.session, file);
}
