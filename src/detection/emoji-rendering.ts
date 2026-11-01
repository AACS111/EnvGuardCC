import type { SignalResult } from './types';
import { EMOJI_FALLBACK_FONT } from './emoji-fallback-font';

export const EMOJI_SAMPLES = ['😀', '🍎', '🚀', '❤️', '👩‍💻', '🏳️‍🌈'] as const;
export const EMOJI_FONTS = ['Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', 'Twemoji Mozilla'] as const;

export type EmojiRenderingEvidence = {
  state: 'sampled' | 'unavailable';
  reason?: 'canvas' | 'pixels' | 'unstable';
  fontStack: string;
  samples: Array<{ text: string; rendered: boolean; colored: boolean; combined: boolean | null; width: number; preview?: string }>;
  fonts: Array<{ name: string; available: boolean; matches: number }>;
  matchedFont: string | null;
  declaredSystem: string;
  consistency: 'typical' | 'different' | 'unknown';
};

type Raster = { pixels: Uint8ClampedArray; width: number; ink: number; colored: boolean; preview?: string };
let probeId = 0;
const equalPixels = (left: Raster, right: Raster) => left.width === right.width && left.pixels.length === right.pixels.length && left.pixels.every((value, index) => value === right.pixels[index]);

async function loadFont(face: FontFace) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([face.load(), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1500); })]); }
  catch { return null; }
  finally { clearTimeout(timer); }
}

// The UA is used only to compare a measured font with a common OS default, never to identify the font.
function declaredSystem(userAgent: string) {
  return /android|harmonyos/i.test(userAgent) ? 'Android' : /iphone|ipad|mac os/i.test(userAgent) ? 'Apple' : /windows/i.test(userAgent) ? 'Windows' : /linux/i.test(userAgent) ? 'Linux' : 'Unknown';
}

export async function probeEmojiRendering(userAgent = ''): Promise<EmojiRenderingEvidence> {
  const evidence: EmojiRenderingEvidence = { state: 'unavailable', reason: 'canvas', fontStack: 'sans-serif', samples: [], fonts: [], matchedFont: null, declaredSystem: declaredSystem(userAgent), consistency: 'unknown' };
  if (typeof document === 'undefined') return evidence;
  const loaded: FontFace[] = [];
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 96;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return evidence;
    evidence.fontStack = typeof getComputedStyle === 'function' && document.body ? getComputedStyle(document.body).fontFamily || 'sans-serif' : 'sans-serif';
    evidence.reason = 'pixels';
    const render = (text: string, font = evidence.fontStack, preview = false): Raster => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.font = `48px ${font}`;
      context.textBaseline = 'alphabetic'; context.textAlign = 'left'; context.direction = 'ltr'; context.fillStyle = '#000';
      context.fillText(text, 8, 72);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0, color = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] < 32) continue;
        ink++;
        if (Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) - Math.min(pixels[index], pixels[index + 1], pixels[index + 2]) > 20) color++;
      }
      let image: string | undefined;
      if (preview) try { image = canvas.toDataURL('image/png'); } catch { /* Pixel measurements remain usable without a preview. */ }
      return { pixels, ink, colored: color >= 4, width: context.measureText(text).width, preview: image };
    };
    // Blank, distinct text and repeat controls reject blocked or unstable pixel readback.
    if (render('').ink || !render('A').ink || equalPixels(render('A'), render('B'))) return evidence;
    const missing = [render('\u{10ffff}'), render('\uffff')];
    const defaults = EMOJI_SAMPLES.map(text => render(text, evidence.fontStack, true));
    if (defaults.some((raster, index) => !equalPixels(raster, render(EMOJI_SAMPLES[index])))) {
      evidence.reason = 'unstable'; return evidence;
    }
    evidence.samples = defaults.map((raster, index) => {
      const text = EMOJI_SAMPLES[index];
      const rendered = raster.ink > 0 && !missing.some(control => equalPixels(control, raster));
      const separate = text.includes('\u200d') ? render(text.replaceAll('\u200d', '')) : null;
      const combined = !rendered || !separate ? null : equalPixels(raster, separate) ? false : raster.width + 1 < separate.width ? true : null;
      return { text, rendered, colored: rendered && raster.colored, combined, width: raster.width, ...(rendered && raster.preview ? { preview: raster.preview } : {}) };
    });
    evidence.state = 'sampled'; delete evidence.reason;
    if (typeof FontFace !== 'undefined' && document.fonts?.add) {
      const id = ++probeId;
      const fallback = await loadFont(new FontFace(`envguard_emoji_fallback_${id}`, `url("${EMOJI_FALLBACK_FONT}")`));
      if (!fallback) return evidence;
      document.fonts.add(fallback); loaded.push(fallback);
      // Every reference needs a known fallback glyph, otherwise missing glyphs can impersonate the default font.
      const traps = EMOJI_SAMPLES.map(text => render(text, `"${fallback.family}"`));
      if (traps.some((trap, index) => !trap.ink || trap.colored || equalPixels(trap, defaults[index]))) return evidence;
      evidence.fonts = await Promise.all(EMOJI_FONTS.map(async (name, index) => {
        const result = { name, available: false, matches: 0 };
        try {
          const face = new FontFace(`envguard_emoji_${id}_${index}`, `local("${name}")`);
          const ready = await loadFont(face);
          if (!ready) return result;
          document.fonts.add(ready); loaded.push(ready); result.available = true;
          result.matches = defaults.filter((raster, sample) => evidence.samples[sample].rendered && equalPixels(raster, render(EMOJI_SAMPLES[sample], `"${ready.family}", "${fallback.family}"`))).length;
        } catch { /* Missing or inaccessible local fonts must not match through CSS fallback. */ }
        return result;
      }));
    }
    const valid = evidence.samples.filter(sample => sample.rendered).length;
    // A single matching glyph, or multiple indistinguishable references, cannot identify a style.
    const matches = evidence.fonts.filter(font => font.available && valid >= 4 && font.matches === valid);
    if (matches.length === 1) evidence.matchedFont = matches[0].name;
    const expected: Record<string, string> = { Apple: 'Apple Color Emoji', Windows: 'Segoe UI Emoji', Android: 'Noto Color Emoji' };
    if (evidence.matchedFont && expected[evidence.declaredSystem]) evidence.consistency = evidence.matchedFont === expected[evidence.declaredSystem] ? 'typical' : 'different';
    return evidence;
  } catch { return evidence; }
  finally { for (const face of loaded) document.fonts.delete(face); }
}

export function emojiRenderingSignal(evidence: EmojiRenderingEvidence, label: string, zh: boolean): SignalResult {
  const valid = evidence.samples.filter(sample => sample.rendered).length;
  const colored = evidence.samples.filter(sample => sample.colored).length;
  const value = evidence.state === 'unavailable'
    ? (zh ? '无法读取 Emoji 渲染像素' : 'Emoji pixels unavailable')
    : evidence.matchedFont
      ? `${evidence.matchedFont}${zh ? ' · 像素匹配' : ' · pixel match'}`
      : zh ? `已采样 ${valid}/${EMOJI_SAMPLES.length} · 字体无法唯一判定` : `Sampled ${valid}/${EMOJI_SAMPLES.length} · font inconclusive`;
  const detail = evidence.state === 'unavailable'
    ? zh ? evidence.reason === 'unstable' ? '重复绘制的像素不一致，无法可靠判定；未使用 User-Agent 代替检测。' : 'Canvas 不可用、像素读取受限或读回校验失败，无法判定；未使用 User-Agent 代替检测。' : 'Canvas or pixel readback is unavailable or unstable. No User-Agent fallback was used.'
    : zh ? `实际绘制 ${EMOJI_SAMPLES.length} 组 Emoji，${valid} 组有有效像素，${colored} 组为彩色。字体结论来自本机已加载字体的逐像素对照；自定义字体及系统回退可能影响结果，不据此推断账号风险。`
      : `Drew ${EMOJI_SAMPLES.length} emoji samples: ${valid} with glyph pixels, ${colored} colored. Font identification compares loaded local references pixel by pixel; custom fonts and system fallback can affect the result. This does not establish account risk.`;
  return { id: 'emojiStyle', label, value, score: 0, weight: 0, contribution: 0, source: 'browser', environment: 'browser', assessment: evidence.state === 'sampled' ? 'ok' : 'unknown', unscored: true, testedAt: new Date().toISOString(), detail, emojiRendering: evidence, ...(evidence.state === 'unavailable' ? { observation: 'unavailable' as const } : {}) };
}
