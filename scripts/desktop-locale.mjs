import { mkdir, readFile, writeFile, rename, rm, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ClassicLevel } from 'classic-level';

const localeKey = Buffer.concat([Buffer.from('_https://claude.ai\0'), Buffer.from([1]), Buffer.from('spa:locale')]);
async function localLocale(directory, operation) {
  try { await access(directory); } catch (error) { if (error.code === 'ENOENT') return operation(null); throw error; }
  let lastError;
  for (let attempt = 0; attempt < 8; attempt++) {
    const db = new ClassicLevel(directory, { keyEncoding: 'buffer', valueEncoding: 'buffer', createIfMissing: false });
    try { await db.open(); return await operation(db); }
    catch (error) {
      lastError = error;
      if (!/lock|being used|resource temporarily unavailable/i.test(error.message + ' ' + error.cause?.message)) throw error;
    } finally { await db.close().catch(() => {}); }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Claude 本地语言存储仍被占用，请先关闭受控客户端后重试。', { cause: lastError });
}
async function readLocalLocale(directory) {
  return localLocale(directory, async db => {
    const value = db ? await db.get(localeKey) : undefined;
    return { had: value !== undefined, value: value?.toString('base64') ?? null };
  });
}

async function readOptional(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function save(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const pending = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(pending, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(pending, file); }
  finally { await rm(pending, { force: true }); }
}
export function desktopLocale(value) {
  const locale = Intl.getCanonicalLocales(value)[0];
  if (!locale) throw new Error('缺少 Claude 桌面语言配置。');
  if (locale === 'zh-CN' || locale === 'zh-SG') return 'zh-Hans';
  if (locale === 'zh-TW' || locale === 'zh-HK') return 'zh-Hant';
  if (locale === 'en') return 'en-US';
  return locale;
}

export class DesktopLocale {
  constructor(stateDir) {
    this.file = path.join(stateDir, 'managed-claude-desktop', 'config.json');
    this.preferences = path.join(stateDir, 'managed-claude-desktop', 'Preferences');
    this.storage = path.join(stateDir, 'managed-claude-desktop', 'Local Storage', 'leveldb');
    this.backup = path.join(stateDir, 'desktop-locale-backup.json');
  }
  async apply(value) {
    const locale = desktopLocale(value);
    const config = await readOptional(this.file) ?? {};
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Claude 桌面配置格式无效。');
    let backup = await readOptional(this.backup);
    if (!backup) backup = { version: 1, hadLocale: Object.hasOwn(config, 'locale'), locale: config.locale ?? null };
    if (backup.version !== 1 || typeof backup.hadLocale !== 'boolean') throw new Error('Claude 语言原始备份无效，已保留原文件。');
    const preferences = await readOptional(this.preferences) ?? {};
    if (!backup.preferences) backup.preferences = { hadIntl: Object.hasOwn(preferences, 'intl'), intl: Object.fromEntries(['accept_languages', 'selected_languages'].map(key => [key, { had: Object.hasOwn(preferences.intl ?? {}, key), value: preferences.intl?.[key] ?? null }])) };
    backup.localStorage ??= await readLocalLocale(this.storage);
    // Save the original once, before the first modification. A region switch must not replace it.
    await save(this.backup, backup);
    await save(this.file, { ...config, locale });
    const languages = [...new Set([locale, locale.split('-')[0], 'en'])].join(',');
    await save(this.preferences, { ...preferences, intl: { ...preferences.intl, accept_languages: languages, selected_languages: languages } });
    await localLocale(this.storage, async db => {
      // A fresh profile follows --lang; only replace an existing explicit web-language choice.
      if (db && await db.get(localeKey) !== undefined) await db.put(localeKey, Buffer.concat([Buffer.from([1]), Buffer.from(locale)]));
    });
    const actual = await readOptional(this.file);
    if (actual?.locale !== locale) throw new Error('Claude 桌面语言写入后核对失败。');
    this.locale = locale;
    return locale;
  }
  async restore() {
    const backup = await readOptional(this.backup);
    if (!backup) return;
    if (backup.version !== 1 || typeof backup.hadLocale !== 'boolean') throw new Error('Claude 语言原始备份无效，无法自动恢复。');
    const config = await readOptional(this.file) ?? {};
    if (backup.hadLocale) config.locale = backup.locale; else delete config.locale;
    await save(this.file, config);
    if (backup.preferences) {
      const preferences = await readOptional(this.preferences) ?? {};
      preferences.intl ??= {};
      for (const [key, original] of Object.entries(backup.preferences.intl)) {
        if (original.had) preferences.intl[key] = original.value; else delete preferences.intl[key];
      }
      if (!backup.preferences.hadIntl && !Object.keys(preferences.intl).length) delete preferences.intl;
      await save(this.preferences, preferences);
    }
    if (backup.localStorage) {
      await localLocale(this.storage, async db => {
        if (!db) { if (backup.localStorage.had) throw new Error('Claude 原始网页语言存储已不存在，备份已保留。'); return; }
        if (backup.localStorage.had) await db.put(localeKey, Buffer.from(backup.localStorage.value, 'base64'));
        else await db.del(localeKey);
      });
      const actual = await readLocalLocale(this.storage);
      if (actual.had !== backup.localStorage.had || actual.value !== backup.localStorage.value) throw new Error('Claude 原始网页语言恢复核对失败。');
    }
    const actual = await readOptional(this.file);
    if (backup.hadLocale ? actual?.locale !== backup.locale : Object.hasOwn(actual ?? {}, 'locale')) throw new Error('Claude 桌面原始语言恢复核对失败。');
    await rm(this.backup);
    this.locale = null;
  }
}
