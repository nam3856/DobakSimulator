import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname, sep } from 'node:path';

const appPath = '/DobakSimulator';
const appRoot = resolve('dist');
const landingRoot = resolve('site-root');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.svg': 'image/svg+xml',
  '.gz': 'application/gzip',
};

createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }

  let url;
  let pathname;
  try {
    url = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    res.end('Invalid URL');
    return;
  }

  if (pathname.includes('\0') || pathname.split(/[/\\]/).includes('..')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (pathname === appPath) {
    res.writeHead(308, { Location: `${appPath}/${url.search}` });
    res.end();
    return;
  }

  const isApp = pathname.startsWith(`${appPath}/`);
  const root = isApp ? appRoot : landingRoot;
  let target = resolve(root, pathname.slice(isApp ? appPath.length + 1 : 1));
  const relativeTarget = relative(root, target);
  if (
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    if ((await stat(target)).isDirectory()) {
      if (!pathname.endsWith('/')) {
        res.writeHead(308, { Location: `${url.pathname}/${url.search}` });
        res.end();
        return;
      }
      target = resolve(target, 'index.html');
    }
    if (!(await stat(target)).isFile()) throw new Error('Not a file');
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': types[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.length,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(4173, '127.0.0.1', () =>
  console.log('Landing and build served at http://127.0.0.1:4173/'),
);
