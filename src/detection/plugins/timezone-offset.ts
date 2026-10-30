// EnvGuardCC 的时区偏移检测插件，用于读取浏览器 UTC 偏移并评估地区环境一致性。
import { offsetScore } from "../signal-rules";
import { makeSignalScore } from "../client-engine";
import type { DetectionPlugin } from "../plugin";

export const timezoneOffsetPlugin: DetectionPlugin = {
  id: "timezoneOffset",
  titleKey: "timezoneOffset",
  source: "browser",
  defaultWeight: 3,
  async run({ text, config }) {
    const offset = -new Date().getTimezoneOffset() / 60;
    return [makeSignalScore("timezoneOffset", text.signalLabels.timezoneOffset, `UTC${offset >= 0 ? "+" : ""}${offset}`, this.defaultWeight, offsetScore(offset), text, config)];
  },
};
