import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const revalidate = false;

function readVersionInfo() {
  try {
    const raw = readFileSync(join(process.cwd(), 'version.json'), 'utf8');
    return JSON.parse(raw) as { builtAt: string; commitSha: string };
  } catch {
    return null;
  }
}

export function GET() {
  const info = readVersionInfo();
  const body = info
    ? `built on ${new Date(info.builtAt).toUTCString()} (commit ${info.commitSha.slice(0, 7)})`
    : 'launched (no build stamp)';
  return new Response(body, { headers: { 'content-type': 'text/plain' } });
}
