import Image from 'next/image';
import type { EmojiRenderingEvidence } from '@/detection/emoji-rendering';
import './emoji-rendering.css';

export function EmojiRenderingDetails({ evidence, zh }: { evidence: EmojiRenderingEvidence; zh: boolean }) {
  if (evidence.state !== 'sampled') return null;
  const text = (cn: string, en: string) => zh ? cn : en;
  const valid = evidence.samples.filter(sample => sample.rendered).length;
  const consistency = evidence.consistency === 'typical'
    ? text('与该系统常见默认字体一致', 'Matches a common default for this system')
    : evidence.consistency === 'different'
      ? text('与该系统常见默认字体不同，可核查自定义字体；不表示设备伪装或账号异常', 'Differs from a common system default; check custom fonts. This does not establish spoofing or account risk')
      : text('证据不足，无法核对默认字体', 'Insufficient evidence to compare system defaults');
  return <section className="emoji-rendering" aria-label={text('Emoji 实际渲染证据', 'Measured emoji rendering')}>
    <h3>{text('实际像素样本', 'Rendered pixel samples')}</h3>
    <ul className="emoji-rendering__samples">{evidence.samples.map(sample => <li key={sample.text}>
      {sample.preview ? <Image src={sample.preview} alt={text(`实际绘制样本 ${sample.text}`, `Rendered sample ${sample.text}`)} width={128} height={48} unoptimized /> : <span>{sample.text}</span>}
      <span>{!sample.rendered ? text('未测得有效字形', 'No glyph pixels') : sample.colored ? text('已绘制 · 彩色', 'Rendered · color') : text('已绘制 · 单色', 'Rendered · monochrome')}</span>
      {sample.text.includes('\u200d') && <small>{sample.combined === true ? text('组合渲染已确认', 'Joined rendering confirmed') : sample.combined === false ? text('组合与拆分结果相同', 'Same result as separate components') : text('组合效果无法判定', 'Joining inconclusive')}</small>}
    </li>)}</ul>
    <h3>{text('本机字体对照', 'Local font references')}</h3>
    <ul>{evidence.fonts.map(font => <li key={font.name}>{font.name}：{font.available ? text(`${font.matches}/${valid} 组像素匹配`, `${font.matches}/${valid} pixel matches`) : text('未安装或无法访问', 'Not installed or inaccessible')}</li>)}</ul>
    {!evidence.fonts.length && <p>{text('无法完成可靠的本机字体对照，保留像素采样，字体无法判定。', 'Reliable local font comparison is unavailable; pixel measurements are retained, but the font is inconclusive.')}</p>}
    <p>{text('浏览器声明系统：', 'Browser-declared system: ')}{evidence.declaredSystem} · {consistency}</p>
    <p>{text('样本及字体对照在本机完成，不上传像素、不更换系统字体。', 'Samples and font comparisons stay on this device; no pixels are uploaded and no system fonts are changed.')}</p>
  </section>;
}
