/**
 * Ephemeral localhost HTTP server used during Actor provisioning.
 *
 * The GitHub App Manifest flow ends with GitHub redirecting the
 * operator's browser to `redirect_url?code=XXX&state=YYY`. We bind a
 * one-shot server that accepts that single request, validates state,
 * resolves with the code, and shuts down. No long-running listener,
 * no hidden port, no persistent surface area.
 *
 * On any request we also render a tiny HTML page in the browser so
 * the operator sees a confirmation and can close the tab.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export interface CallbackResult {
  readonly code: string;
  readonly state: string;
}

export interface CallbackServerHandle {
  /** The redirect_url you pass to GitHub, e.g. http://127.0.0.1:53211/callback */
  readonly redirectUrl: string;
  /** Resolves with the code+state once GitHub has called back. */
  readonly awaitCallback: () => Promise<CallbackResult>;
  /** Manual stop. Normally the server stops itself after the callback. */
  readonly stop: () => Promise<void>;
}

export interface StartCallbackServerOptions {
  /** Expected state value. Reject any callback that doesn't match. */
  readonly expectedState: string;
  /** Override the path; default '/callback'. */
  readonly path?: string;
  /** Host to bind; default 127.0.0.1 (loopback only). */
  readonly host?: string;
  /** Timeout for the callback in ms; default 10 minutes. */
  readonly timeoutMs?: number;
}

const SUCCESS_HTML = (roleLabel: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Actor provisioned</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:64px auto;padding:0 24px;color:#1a1a1a}h1{font-size:20px}p{line-height:1.5}</style>
</head><body><h1>Actor provisioned: ${escapeHtml(roleLabel)}</h1>
<p>LAG has received the App credentials and stored them locally.</p>
<p>You can close this tab and return to your terminal.</p>
</body></html>`;

const ERROR_HTML = (detail: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Callback error</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:64px auto;padding:0 24px;color:#8a1a1a}h1{font-size:20px}p{line-height:1.5}code{background:#f3f3f3;padding:2px 6px;border-radius:4px}</style>
</head><body><h1>Callback error</h1>
<p>${escapeHtml(detail)}</p>
<p>Check the LAG terminal for details.</p>
</body></html>`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function startCallbackServer(
  opts: StartCallbackServerOptions,
): Promise<CallbackServerHandle> {
  const path = opts.path ?? '/callback';
  const host = opts.host ?? '127.0.0.1';
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;

  let resolver: ((r: CallbackResult) => void) | null = null;
  let rejector: ((e: Error) => void) | null = null;
  const resultPromise = new Promise<CallbackResult>((res, rej) => {
    resolver = res;
    rejector = rej;
  });
  let handled = false;
  let server: Server | null = null;

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end('missing url');
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== path) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (handled) {
      res.statusCode = 409;
      res.end('already handled');
      return;
    }
    handled = true;

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    if (!code || !state) {
      res.statusCode = 400;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(ERROR_HTML('GitHub did not return code and state.'));
      rejector?.(new Error('callback missing code or state'));
      return;
    }
    if (state !== opts.expectedState) {
      res.statusCode = 400;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(ERROR_HTML('state mismatch; refusing to exchange code.'));
      rejector?.(new Error(`state mismatch: got ${state}, want ${opts.expectedState}`));
      return;
    }

    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(SUCCESS_HTML(state));
    resolver?.({ code, state });
  };

  server = createServer(onRequest);
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, host, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const redirectUrl = `http://${host}:${addr.port}${path}`;

  const timeout = setTimeout(() => {
    if (!handled) {
      handled = true;
      rejector?.(new Error(`callback timed out after ${timeoutMs}ms`));
    }
  }, timeoutMs);

  const stop = async (): Promise<void> => {
    clearTimeout(timeout);
    if (server) {
      await new Promise<void>((res) => server!.close(() => res()));
      server = null;
    }
  };

  return {
    redirectUrl,
    awaitCallback: async () => {
      try {
        return await resultPromise;
      } finally {
        await stop();
      }
    },
    stop,
  };
}
