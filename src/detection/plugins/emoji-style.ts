import { emojiRenderingSignal, probeEmojiRendering } from "../emoji-rendering";
import type { DetectionPlugin } from "../plugin";

export const emojiStylePlugin: DetectionPlugin = {
  id: "emojiStyle",
  titleKey: "emojiStyle",
  source: "browser",
  defaultWeight: 0,
  async run({ browser, text, locale }) {
    return [emojiRenderingSignal(await probeEmojiRendering(browser.userAgent), text.signalLabels.emojiStyle, locale.startsWith('zh'))];
  },
};
