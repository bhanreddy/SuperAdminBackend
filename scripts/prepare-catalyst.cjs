const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const dotenv = require('dotenv');

const root = path.resolve(__dirname, '..');
const build = path.join(root, '.catalyst-build');
const template = JSON.parse(fs.readFileSync(path.join(root, 'app-config.example.json'), 'utf8'));
const envPath = process.env.CATALYST_ENV_FILE || path.join(root, '.env');
const env = dotenv.parse(fs.readFileSync(envPath));
for (const key of ['SCHOOL_SUPABASE_URL', 'SCHOOL_SUPABASE_ANON_KEY', 'SCHOOL_SUPABASE_SERVICE_ROLE_KEY', 'SCHOOL_DATABASE_URL']) {
  if (!env[key]?.trim()) throw new Error(`Missing deployment environment variable: ${key}`);
}
// AppSail supplies the listening port. Use the request origin until its public URL is set.
delete env.PORT;
if (/your-real-backend-domain\.com/.test(env.PUBLIC_BASE_URL || '')) delete env.PUBLIC_BASE_URL;
if (process.env.CATALYST_PUBLIC_BASE_URL) env.PUBLIC_BASE_URL = process.env.CATALYST_PUBLIC_BASE_URL;

fs.rmSync(build, { recursive: true, force: true });
fs.mkdirSync(build, { recursive: true });
fs.cpSync(path.join(root, 'src'), path.join(build, 'src'), { recursive: true });
fs.cpSync(path.join(root, 'templates'), path.join(build, 'templates'), { recursive: true });
for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(root, file), path.join(build, file));
// AppSail runs Linux x64; sharp needs that platform's native optional packages.
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts', '--os=linux', '--cpu=x64', '--libc=glibc', '--no-audit', '--no-fund'], { cwd: build, stdio: 'inherit' });
const config = { ...template, env_variables: env };
fs.writeFileSync(path.join(root, 'app-config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(path.join(root, 'app-config.json'), 0o600);
console.log('AppSail build prepared. Secrets are stored only in ignored app-config.json, outside the upload directory.');
