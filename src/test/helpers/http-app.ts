/**
 * Mount an express router on a real HTTP server for route tests, and talk to it with fetch.
 *
 * The routes under test are built from injected dependencies (fake auth, fake service), so these
 * tests need no database, no credentials and no network beyond localhost.
 */
import express, { type Router } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestApp {
  baseUrl: string;
  close(): Promise<void>;
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; headers: Headers; body: any }>;
}

export async function startTestApp(mounts: Array<[path: string, router: Router]>): Promise<TestApp> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  for (const [path, router] of mounts) app.use(path, router);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    async post(path, body, headers = {}) {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let parsed: any = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* non-JSON body */
      }
      return { status: res.status, headers: res.headers, body: parsed };
    },
  };
}

/** Plugin-style auth double: 401 without the headers, else attaches a user and a website. */
export function fakePluginAuth(user = { id: 7 }, website: { id: number } | null = { id: 3 }) {
  return (req: any, res: any, next: any) => {
    if (!req.headers['x-api-key'] || !req.headers['x-site-code']) {
      return res.status(401).json({ success: false, error: 'API key and site code are required' });
    }
    req.user = user;
    req.website = website;
    next();
  };
}

export const PLUGIN_HEADERS = { 'x-api-key': 'test-key', 'x-site-code': 'test-site' };
