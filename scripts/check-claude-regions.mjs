// Claude 支持地区清单的可执行断言：清单本身会过期，但「哪些地区不能放行」不能靠猜。
import test from "node:test";
import assert from "node:assert/strict";
import { CLAUDE_SUPPORTED_REGION_CODES, CLAUDE_SUPPORTED_REGIONS_URL, claudeRegionSupport, assertClaudeSupportedExit, normalizeCountryCode } from "../src/detection/claude-regions.mjs";

test("官方清单：常见地区分类正确", () => {
  for (const code of ["US", "KR", "JP", "TW", "SG", "DE", "GB", "CA"]) assert.equal(claudeRegionSupport(code), "supported", code);
  for (const code of ["CN", "HK", "MO", "RU", "BY", "IR", "KP", "SY", "CU", "VE", "MM", "AF", "YE"]) {
    assert.equal(claudeRegionSupport(code), "unsupported", `${code} 不应出现在 Claude 支持地区内`);
  }
});

test("清单没有重复，也没有已废弃的两位代码", () => {
  assert.equal(new Set(CLAUDE_SUPPORTED_REGION_CODES).size, CLAUDE_SUPPORTED_REGION_CODES.length);
  for (const code of CLAUDE_SUPPORTED_REGION_CODES) assert.match(code, /^[A-Z]{2}$/);
  // CS/DD/NH/RH 等是旧代码，混进来通常意味着生成脚本把历史别名当成了国家。
  for (const stale of ["CS", "DD", "NH", "RH", "SU", "YU", "AN", "ZR", "BU", "TP"]) {
    assert.equal(CLAUDE_SUPPORTED_REGION_CODES.includes(stale), false, `${stale} 是已废弃代码`);
  }
});

test("代码归一化：大小写与空白都接受，无效值不猜", () => {
  assert.equal(normalizeCountryCode(" kr "), "KR");
  assert.equal(normalizeCountryCode("Cn"), "CN");
  assert.equal(normalizeCountryCode("KOR"), null);
  assert.equal(normalizeCountryCode(""), null);
  assert.equal(normalizeCountryCode(undefined), null);
  assert.equal(claudeRegionSupport(null), "unknown");
});

test("支持地区放行，不支持地区拒绝并带出可操作信息", () => {
  assert.equal(assertClaudeSupportedExit({ countryCode: "kr", ip: "43.133.78.123" }), "KR");
  assert.throws(
    () => assertClaudeSupportedExit({ countryCode: "CN", ip: "203.0.113.9" }),
    new RegExp(`Claude 不支持的地区：CN（203\\.0\\.113\\.9）.*${CLAUDE_SUPPORTED_REGIONS_URL}`),
  );
  assert.throws(() => assertClaudeSupportedExit({ countryCode: "HK" }), /不支持的地区：HK/);
  // 拿不到国家码时不能默认放行。
  assert.throws(() => assertClaudeSupportedExit({ ip: "203.0.113.9" }), /缺少可识别的国家\/地区代码/);
});
