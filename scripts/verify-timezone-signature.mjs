import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const directory = path.resolve(process.argv[2]);
const exec = promisify(execFile);
const { stderr } = await exec('/usr/bin/codesign', ['-d', '--verbose=4', path.join(directory, 'bridge')]);
if (stderr.match(/^CDHash=([a-f0-9]+)$/m)?.[1] !== (await readFile(path.join(directory, 'client-cdhash'), 'utf8')).trim()) throw new Error('打包改变了时区客户端签名，拒绝交付。');
await exec('/usr/bin/codesign', ['--verify', '--strict', path.join(directory, 'daemon')]);
