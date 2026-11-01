import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [input, revision] = process.argv.slice(2);
if (!input || !/^[a-f0-9]{40}$/i.test(revision ?? '')) throw new Error('Usage: node scripts/build-hosting-asns.mjs <as.json> <upstream commit SHA>');
const raw = await readFile(input);
const records = JSON.parse(raw);
if (!Array.isArray(records)) throw new Error('Invalid AS metadata');
const asns = Object.fromEntries(records.filter(item => Number.isInteger(item.asn) && item.asn > 0 && item.metadata?.category === 'hosting' && typeof item.metadata.description === 'string')
  .map(item => [String(item.asn), item.metadata.description]));
if (Object.keys(asns).length < 1000) throw new Error('Incomplete hosting AS metadata');
const data = { source: 'https://github.com/ipverse/as-metadata', revision, sourceSha256: createHash('sha256').update(raw).digest('hex'), asns };
const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/detection/hosting-asns.json');
await writeFile(output, JSON.stringify(data) + '\n');
console.log(`Wrote ${Object.keys(asns).length} hosting ASNs to ${output}`);
