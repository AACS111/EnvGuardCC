// 出口类型识别：云机房/托管 IP 的警告不能靠猜：ASN 与 org/isp/domain 都要覆盖。
import test from "node:test";
import assert from "node:assert/strict";
import { isHostingExit, describeExit } from "../src/detection/exit-quality.mjs";

test("云厂商 ASN/org 识别为托管 IP", () => {
  assert.equal(isHostingExit({ asn: 132203, org: "6 COLLYER QUAY", isp: "Shenzhen Tencent Computer Systems Company Limited", domain: "tencent.com" }), true);
  assert.equal(isHostingExit({ asn: 16509, org: "Amazon.com, Inc." }), true);
  assert.equal(isHostingExit({ asn: 15169, isp: "Google LLC" }), true);
  assert.equal(isHostingExit({ org: "OVH SAS" }), true);
  assert.equal(isHostingExit({ org: "DigitalOcean, LLC" }), true);
  assert.equal(isHostingExit({ org: "Alibaba (US) Technology Co., Ltd." }), true);
});

test("住宅/移动运营商不误报", () => {
  assert.equal(isHostingExit({ asn: 4766, org: "Korea Telecom", isp: "Korea Telecom" }), false);
  assert.equal(isHostingExit({ asn: 3786, org: "LG POWERCOMM", isp: "LG U+" }), false);
  assert.equal(isHostingExit({ asn: 2516, org: "KDDI CORPORATION" }), false);
  assert.equal(isHostingExit({}), false);
  assert.equal(isHostingExit({ org: "" }), false);
});

test("描述包含可读组织与 ASN", () => {
  const text = describeExit({ asn: 132203, org: "6 COLLYER QUAY", isp: "Shenzhen Tencent Computer Systems Company Limited" });
  assert.match(text, /AS132203/);
  assert.match(text, /Tencent|COLLYER/);
});
