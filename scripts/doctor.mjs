import { spawnSync } from 'node:child_process';

console.log('ONE development environment');
for (const [name, args] of [
  ['node', ['--version']],
  ['git', ['--version']],
  ['rustc', ['--version']],
  ['cargo', ['--version']],
]) {
  const result = spawnSync(name, args, { encoding: 'utf8', shell: false });
  console.log(
    `${name}: ${result.status === 0 ? result.stdout.trim() : 'not available on PATH'}`,
  );
}
console.log('Web: pnpm install -> pnpm dev');
console.log(
  'Desktop also requires Rust MSVC, C++ Build Tools and WebView2 on Windows.',
);
console.log(
  'See docs/07-development.md. This check does not verify C++ or WebView2.',
);
