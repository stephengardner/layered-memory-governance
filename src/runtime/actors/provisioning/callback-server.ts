/**
 * Ephemeral localhost HTTP server used during Actor provisioning.
 *
 * Serves two endpoints on the same random loopback port:
 *
 *   GET  /start    Returns an HTML page with a hidden form that
 *                  auto-POSTs to GitHub's manifest-registration URL.
 *                  This is required because GitHub's App Manifest
 *                  flow only accepts the manifest via a form POST,
 *                  not as a URL query parameter.
 *
 *   GET  /callback Endpoint GitHub redirects to after the operator
 *                  approves App creation. Carries `?code=...&state=...`.
 *                  We validate state, resolve the code, and shut down.
 *
 * No long-running listener, no hidden port, no persistent surface area.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export interface CallbackResult {
  readonly code: string;
  readonly state: string;
}

export interface CallbackServerHandle {
  /** URL the operator opens in their browser. Redirects to GitHub via form POST. */
  readonly startUrl: string;
  /** URL GitHub redirects to after the operator approves. Embedded in the manifest. */
  readonly redirectUrl: string;
  /** Resolves with the code+state once GitHub has called back. */
  readonly awaitCallback: () => Promise<CallbackResult>;
  /** Manual stop. Normally the server stops itself after the callback. */
  readonly stop: () => Promise<void>;
}

export interface StartCallbackServerOptions {
  /** Expected state value. Reject any callback that doesn't match. */
  readonly expectedState: string;
  /**
   * Human label shown on the success HTML page (role or App name).
   * State tokens are random hex; rendering them as the label shows
   * a meaningless string to the operator. Default: 'your actor'.
   */
  readonly successLabel?: string;
  /**
   * Builds the App manifest JSON. Called once, after the server has
   * bound to a port. Receives the final redirect URL (which embeds
   * the bound port) so the manifest's `redirect_url`/`url` fields are
   * correct. The returned string is posted to GitHub's App creation
   * URL inside a hidden form on /start.
   */
  readonly buildManifestJson: (redirectUrl: string) => string;
  /**
   * Optional GitHub organization login. When present, the form POSTs to
   * /organizations/<org>/settings/apps/new; otherwise to /settings/apps/new
   * (personal account).
   */
  readonly organization?: string;
  /** Override the path; default '/callback'. */
  readonly callbackPath?: string;
  /** Override the path; default '/start'. */
  readonly startPath?: string;
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

function buildStartHtml(opts: {
  readonly action: string;
  readonly manifestJson: string;
  readonly state: string;
}): string {
  // Double-escape: once for HTML attribute safety, once naturally because
  // JSON contains quotes which the browser parser must see as part of the
  // attribute value.
  const manifestAttr = escapeHtml(opts.manifestJson);
  const action = escapeHtml(opts.action);
  const state = escapeHtml(opts.state);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Redirecting to GitHub</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:64px auto;padding:0 24px;color:#1a1a1a}h1{font-size:20px}p{line-height:1.5}form{margin-top:24px}button{font-size:14px;padding:8px 14px;border-radius:6px;border:1px solid #2f2f2f;background:#24292f;color:#fff;cursor:pointer}</style>
</head><body>
<h1>Redirecting to GitHub...</h1>
<p>LAG is handing the App manifest to GitHub so it can create your Actor identity.</p>
<p>If this page does not redirect automatically, click the button below.</p>
<form id="manifest-form" action="${action}" method="post">
  <input type="hidden" name="manifest" value="${manifestAttr}">
  <input type="hidden" name="state" value="${state}">
  <button type="submit">Continue to GitHub</button>
</form>
<script>document.getElementById('manifest-form').submit();</script>
</body></html>`;
}

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
  const callbackPath = opts.callbackPath ?? '/callback';
  const startPath = opts.startPath ?? '/start';
  const host = opts.host ?? '127.0.0.1';
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;

  const githubAction = opts.organization
    ? `https://github.com/organizations/${encodeURIComponent(opts.organization)}/settings/apps/new`
    : 'https://github.com/settings/apps/new';

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

    if (url.pathname === startPath) {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(buildStartHtml({
        action: githubAction,
        manifestJson: manifestJsonCached,
        state: opts.expectedState,
      }));
      return;
    }

    if (url.pathname !== callbackPath) {
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
    res.end(SUCCESS_HTML(opts.successLabel ?? 'your actor'));
    resolver?.({ code, state });
  };

  server = createServer(onRequest);
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, host, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const startUrl = `http://${host}:${addr.port}${startPath}`;
  const redirectUrl = `http://${host}:${addr.port}${callbackPath}`;
  const manifestJsonCached = opts.buildManifestJson(redirectUrl);

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
    startUrl,
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
