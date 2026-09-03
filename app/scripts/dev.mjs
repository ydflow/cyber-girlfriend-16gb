import { spawn } from 'node:child_process';
import process from 'node:process';

const children = [];
let stopping = false;

function start(label, args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  children.push(child);
  child.on('exit', (code) => {
    if (stopping) return;
    console.error(`${label} 已停止（退出码 ${code ?? '未知'}）`);
    stop(code ?? 1);
  });
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => process.exit(code), 100);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

start('本地后端', ['server/index.mjs']);
start('网页界面', [
  'node_modules/vite/bin/vite.js',
  '--host',
  '127.0.0.1',
  '--port',
  '3000',
  '--strictPort',
]);
