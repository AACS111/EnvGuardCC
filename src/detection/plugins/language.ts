// EnvGuardCC 的语言检测插件，用于读取浏览器语言列表并评估地区语言偏好风险。
import * as rules from "../signal-rules";
import { makeSignalScore } from "../client-engine";
import type { DetectionPlugin } from "../plugin";

export const languagePlugin: DetectionPlugin = {
  id: "language",
  titleKey: "language",
  source: "browser",
  defaultWeight: 5,
  async run({ browser, text, config }) {
    const languageScore = rules.languageScore(browser.languages);
    return [makeSignalScore("language", text.signalLabels.language, browser.languages.join(", "), this.defaultWeight, languageScore, text, config)];
  },
};
