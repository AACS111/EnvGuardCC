// EnvGuardCC 的时区检测插件，用于读取浏览器时区并评估 Claude 运行环境的地区一致性。
import * as rules from "../signal-rules";
import { makeSignalScore } from "../client-engine";
import type { DetectionPlugin } from "../plugin";

export const timezonePlugin: DetectionPlugin = {
  id: "timezone",
  titleKey: "timezone",
  source: "browser",
  defaultWeight: 26,
  async run({ browser, text, config }) {
    const timezoneScore = rules.timezoneScore(browser.timezone ?? "");
    return [makeSignalScore("timezone", text.signalLabels.timezone, browser.timezone, this.defaultWeight, timezoneScore, text, config)];
  },
};
