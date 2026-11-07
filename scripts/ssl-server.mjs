
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
function getArg(name, def) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
}

const port = parseInt(getArg('port', '443'), 10);
const docroot = path.resolve(getArg('docroot', path.join(rootDir, 'public')));
const keyFile = getArg('key', path.join(rootDir, 'resources', 'xenblox_xyz.key'));
const certFile = path.join(rootDir, 'resources', 'xenblox_xyz.crt');
const caBundleFile = path.join(rootDir, 'resources', 'xenblox_xyz.ca-bundle');

let privateKey;
try {
  privateKey = fs.readFileSync(keyFile, 'utf8');
} catch {
  console.error(`ERROR: Private key not found at: ${keyFile}`);
  console.error(`The .key file is the one generated alongside your CSR when`);
  console.error(`you purchased the certificate from SSL.com.`);
  console.error('');
  console.error('If you have a .pfx file instead, convert it with:');
  console.error(`  openssl pkcs12 -in yourfile.pfx -out ${keyFile} -nodes`);
  console.error('');
  console.error('If you need to create a new key+CSR (this will require a');
  console.error('new certificate from SSL.com):');
  console.error(`  openssl req -new -key ${keyFile} -out xenblox.csr -subj "/CN=xenblox.xyz"`);
  process.exit(1);
}

const certificate = fs.readFileSync(certFile, 'utf8');
let credentials;
try {
  const caBundle = fs.readFileSync(caBundleFile, 'utf8');
  credentials = { key: privateKey, cert: certificate, ca: [caBundle] };
} catch {
  credentials = { key: privateKey, cert: certificate };
}

const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

const server = https.createServer(credentials, (req, res) => {
  let filePath = path.join(docroot, req.url === '/' ? 'index.html' : req.url);
  filePath = path.normalize(filePath);

  if (!filePath.startsWith(docroot)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('Not Found');
      } else {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(port, () => {
  console.log(`HTTPS server running on https://localhost:${port}/`);
  console.log(`Serving files from: ${docroot}`);
  console.log(`Certificate: ${certFile}`);
  console.log(`Private key: ${keyFile}`);
});
