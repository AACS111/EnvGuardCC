// EnvGuardCC 的 Locale 检测插件，用于读取浏览器 Intl Locale 并判断与目标地区的匹配风险。
import * as rules from "../signal-rules";
import { makeSignalScore } from "../client-engine";
import type { DetectionPlugin } from "../plugin";

export const localePlugin: DetectionPlugin = {
  id: "locale",
  titleKey: "locale",
  source: "browser",
  defaultWeight: 4,
  async run({ browser, text, config }) {
    const localeScore = rules.localeScore(browser.locale ?? "");
    return [makeSignalScore("locale", text.signalLabels.locale, browser.locale, this.defaultWeight, localeScore, text, config)];
  },
};
