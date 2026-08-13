/**
 * Build a single self-contained HTML file of the landing page for design
 * review, with the stylesheet and all JavaScript (including Three.js) inlined
 * so it runs from any static host with no backend.
 *
 *   node scripts/build-preview.mjs [outfile]
 *
 * The preview's sign-in form is inert by design: it is a visual mock-up, not a
 * working login, and says so on the page.
 */
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = process.argv[2] || path.join(root, 'preview', 'daily-regulatory-preview.html');

// globe.js imports Three.js by absolute URL, which only resolves when served by
// the app. Map it to the package for the bundle.
const resolveVendor = {
  name: 'vendor-paths',
  setup(build) {
    build.onResolve({ filter: /^\/vendor\/three\.module\.js$/ }, () => ({
      path: path.join(root, 'node_modules', 'three', 'build', 'three.module.js'),
    }));
  },
};

const bundle = await esbuild.build({
  entryPoints: [path.join(root, 'scripts', 'preview-entry.js')],
  bundle: true,
  format: 'esm',
  minify: true,
  write: false,
  plugins: [resolveVendor],
  legalComments: 'none',
});

const js = bundle.outputFiles[0].text;
const css = fs.readFileSync(path.join(root, 'public', 'css', 'main.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

// Take the page body from the real landing page so the preview cannot drift
// from what the application actually serves.
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));

const preview = `<title>Daily Regulatory</title>
<style>
${css}

/* Preview-only: the notice explaining that this page has no backend. */
.preview-note {
  position: relative;
  z-index: 3;
  background: linear-gradient(90deg, rgba(139,92,246,.18), rgba(34,211,238,.14));
  border-bottom: 1px solid var(--border-strong);
  color: var(--text);
  font-size: 13px;
  padding: 10px 24px;
  text-align: center;
  line-height: 1.5;
}
.preview-note strong { color: #d8c4ff; }
.auth-card form input, .auth-card form button { pointer-events: none; opacity: .62; }
</style>

<div class="preview-note">
  <strong>Design preview.</strong>
  Static snapshot of the Daily Regulatory landing page &mdash; the globe is live and
  interactive (drag to rotate), but there is no server behind this page, so sign-in
  and registration are disabled here.
</div>

${body.replace(/<script[\s\S]*?<\/script>/g, '')}

<script type="module">
${js}
</script>
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, preview);

const kb = (Buffer.byteLength(preview) / 1024).toFixed(0);
console.log(`Wrote ${outFile} (${kb} KB, fully self-contained)`);
