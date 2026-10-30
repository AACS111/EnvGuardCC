// EnvGuardCC 的检测模块本地化工具，用于定义检测文案结构并按语言展示地区和信号值。
import type { LocaleCode } from "@/i18n/messages";
import type { RegionCode } from "./types";

export type TargetRegion = RegionCode | "hk";

export type DetectorLocaleText = {
  pending: string;
  unknown: string;
  signalLabels: Record<string, string>;
  signalValues: Record<string, string>;
  ipMetricLabels: Record<string, string>;
  regions: Record<TargetRegion, string>;
  status: Record<string, string>;
  risk: { waiting: string; checking: string; supported: string; blocked: string; high: string; light: string };
  valueMap: Record<string, string>;
  confidence: { high: string; medium: string; low: string; safe: string; highRiskRegion: string; supportedRegion: string };
};

export function localizeLocation(value: string, locale: LocaleCode) {
  if (locale !== "ru") return value;
  return value.replace(/日本/g, "Япония").replace(/东京都/g, "Токио").replace(/东京/g, "Токио").replace(/中国大陆/g, "материковый Китай").replace(/中国/g, "Китай");
}

export const detectorLocaleText: Record<LocaleCode, DetectorLocaleText> = {
  zh: {
    pending: "等待检测",
    unknown: "未知",
    signalLabels: {
      timezone: "系统时区", language: "浏览器语言", languageVariant: "语言文字特征", chineseFonts: "字体地区特征",
      vendorFonts: "厂商字体异常", domesticBrowser: "浏览器地区特征", domesticDevice: "设备地区特征", locale: "Intl 区域设置",
      timezoneOffset: "时区偏移", emojiStyle: "Emoji 渲染风格", country: "网络出口", proxyCountry: "代理出口国家",
      ipv4: "IPv4", browserIpLocation: "IP 位置", browserIpOrg: "网络组织", os: "操作系统",
      claudeReachability: "claude.ai 浏览器侧可达性", anthropicReachability: "Anthropic 官网浏览器侧可达性",
      apiReachability: "Anthropic API 浏览器侧可达性", claudeTrigger: "Claude 浏览器侧触发状态",
      claudeLatency: "Claude 浏览器侧触发延迟", webrtcSupport: "WebRTC 支持状态", webrtcCandidates: "WebRTC UDP 候选地址",
      webrtcLeak: "WebRTC 公网 IP 泄漏", webrtcLeakCount: "WebRTC 泄漏 IP 数", webrtcFirstIp: "首个 WebRTC 泄漏 IP",
      webrtcRegion: "WebRTC 泄漏地区风险", webrtcConsistency: "WebRTC 与网络出口一致性",
      dnsMode: "DNS 检测模式", dnsReview: "DNS 解析路径验证", dnsConsistency: "DNS 多源参考核对", gatewayProfile: "浏览器/应用环境",
      deviceLineage: "设备/系统线索", edgeCountry: "边缘访问国家", edgeColo: "Cloudflare 边缘机房", edgeCity: "边缘访问城市",
      edgeAsn: "边缘 ASN", edgeOrg: "边缘网络组织", requestHeaders: "请求头完整性", httpLanguage: "HTTP 语言偏好",
      secFetch: "Sec-Fetch 访问画像", clientHints: "Client Hints 画像", exitType: "网络出口类型", multiSourceConsistency: "IP 情报一致性",
      ipSourceCount: "IP 情报源数量", countrySet: "多源国家集合", ipCountryRisk: "IP 风险国家", claudeAccessRisk: "Claude 访问风险",
      asn: "ASN", browser: "浏览器", device: "设备环境",
    },
    signalValues: {
      unknown: "未知", noBrands: "无 UA-CH brands", noLanguageVariant: "未命中重点语言文字",
      simplifiedChinese: "简体中文", traditionalChinese: "繁体中文", scFonts: "中国字体", tcFonts: "中文繁体字体",
      noFonts: "未命中重点地区字体", vendorFontsFound: "命中设备厂商字体", noVendorFonts: "未命中设备厂商字体",
      domesticBrowserFound: "命中国产浏览器", noDomesticBrowser: "未命中国产浏览器",
      domesticDeviceFound: "命中国产设备特征", noDomesticDevice: "未命中重点设备特征",
      unknownBrowser: "未知浏览器", unknownSystem: "未知系统", wechatBrowser: "微信内置浏览器",
      androidDevice: "Android 设备", linuxDevice: "Linux 设备", appleEmoji: "Apple Emoji 风格",
      androidEmoji: "Android / 厂商 Emoji 风格", windowsEmoji: "Windows Emoji 风格", unknownEmoji: "未知 Emoji 风格",
      read: "已读取", webrtcSupported: "浏览器支持", webrtcUnsupported: "浏览器不支持", candidateUnit: "个候选地址",
      webrtcLeakFound: "发现公网 IP", webrtcNoLeak: "未发现公网 IP", webrtcRegionUnknown: "需要 IP 情报才能判定",
      cannotDetermine: "需对比出口 IP 才能判定", notMeasured: "未测得", coreUnit: " 核", touchUnit: " 触控点",
    },
    ipMetricLabels: { ipAddress: "IP 地址", ipv6: "IPv6", ipv4: "IPv4", asn: "ASN", asnOwner: "ASN 所有者", company: "企业", longitude: "经度", latitude: "纬度", ipType: "IP 类型", risk: "风控值", isp: "ISP" },
    regions: { auto: "自动检测", cn: "中国大陆", hk: "香港", ru: "俄罗斯", ir: "伊朗" },
    status: { restricted: "高风险 / 可能受限", possibly_supported: "需要进一步确认", unsupported: "不支持", supported: "完美支持", unknown: "未确认" },
    risk: { waiting: "等待检测", checking: "检测中", supported: "完美支持", blocked: "封号风险", high: "高危风险", light: "轻度风险" },
    valueMap: { "中国大陆 IP": "中国大陆 IP", "访问和订阅风险极高": "访问和订阅风险极高" },
    confidence: { high: "高度疑似", medium: "疑似", low: "少量命中", safe: "环境安全，疑似", highRiskRegion: "高风险地区", supportedRegion: "官方支持地区" },
  },
  "zh-HK": {
    pending: "等待檢測",
    unknown: "未知",
    signalLabels: {
      timezone: "系統時區", language: "瀏覽器語言", languageVariant: "語言文字特徵", chineseFonts: "字體地區特徵",
      vendorFonts: "廠商字體異常", domesticBrowser: "瀏覽器地區特徵", domesticDevice: "設備地區特徵", locale: "Intl 區域設定",
      timezoneOffset: "時區偏移", emojiStyle: "Emoji 渲染風格", country: "網絡出口", proxyCountry: "代理出口國家",
      ipv4: "IPv4", browserIpLocation: "IP 位置", browserIpOrg: "網絡組織", os: "作業系統",
      claudeReachability: "claude.ai 瀏覽器側可達性", anthropicReachability: "Anthropic 官網瀏覽器側可達性",
      apiReachability: "Anthropic API 瀏覽器側可達性", claudeTrigger: "Claude 瀏覽器側觸發狀態",
      claudeLatency: "Claude 瀏覽器側觸發延遲", webrtcSupport: "WebRTC 支援狀態", webrtcCandidates: "WebRTC UDP 候選地址",
      webrtcLeak: "WebRTC 公網 IP 洩漏", webrtcLeakCount: "WebRTC 洩漏 IP 數", webrtcFirstIp: "首個 WebRTC 洩漏 IP",
      webrtcRegion: "WebRTC 洩漏地區風險", webrtcConsistency: "WebRTC 與網絡出口一致性",
      dnsMode: "DNS 檢測模式", dnsReview: "DNS 解析路徑驗證", dnsConsistency: "DNS 多源參考核對", gatewayProfile: "瀏覽器/應用環境",
      deviceLineage: "設備/系統線索", edgeCountry: "邊緣訪問國家", edgeColo: "Cloudflare 邊緣機房", edgeCity: "邊緣訪問城市",
      edgeAsn: "邊緣 ASN", edgeOrg: "邊緣網絡組織", requestHeaders: "請求頭完整性", httpLanguage: "HTTP 語言偏好",
      secFetch: "Sec-Fetch 訪問畫像", clientHints: "Client Hints 畫像", exitType: "網絡出口類型", multiSourceConsistency: "IP 情報一致性",
      ipSourceCount: "IP 情報源數量", countrySet: "多源國家集合", ipCountryRisk: "IP 風險國家", claudeAccessRisk: "Claude 訪問風險",
      asn: "ASN", browser: "瀏覽器", device: "設備環境",
    },
    signalValues: {
      unknown: "未知", noBrands: "無 UA-CH brands", noLanguageVariant: "未命中重點語言文字",
      simplifiedChinese: "中文簡體", traditionalChinese: "中文繁體", scFonts: "中國內地字體", tcFonts: "中文繁體字體",
      noFonts: "未命中重點地區字體", vendorFontsFound: "命中設備廠商字體", noVendorFonts: "未命中設備廠商字體",
      domesticBrowserFound: "命中國產瀏覽器", noDomesticBrowser: "未命中國產瀏覽器",
      domesticDeviceFound: "命中國產設備特徵", noDomesticDevice: "未命中重點設備特徵",
      unknownBrowser: "未知瀏覽器", unknownSystem: "未知系統", wechatBrowser: "微信內置瀏覽器",
      androidDevice: "Android 設備", linuxDevice: "Linux 設備", appleEmoji: "Apple Emoji 風格",
      androidEmoji: "Android / 廠商 Emoji 風格", windowsEmoji: "Windows Emoji 風格", unknownEmoji: "未知 Emoji 風格",
      read: "已讀取", webrtcSupported: "瀏覽器支援", webrtcUnsupported: "瀏覽器不支援", candidateUnit: "個候選地址",
      webrtcLeakFound: "發現公網 IP", webrtcNoLeak: "未發現公網 IP", webrtcRegionUnknown: "需要 IP 情報才能判定",
      cannotDetermine: "需對比出口 IP 才能判定", notMeasured: "未測得", coreUnit: " 核", touchUnit: " 觸控點",
    },
    ipMetricLabels: { ipAddress: "IP 地址", ipv6: "IPv6", ipv4: "IPv4", asn: "ASN", asnOwner: "ASN 擁有者", company: "企業", longitude: "經度", latitude: "緯度", ipType: "IP 類型", risk: "風控值", isp: "ISP" },
    regions: { auto: "自動檢測", cn: "中國內地", hk: "香港", ru: "俄羅斯", ir: "伊朗" },
    status: { restricted: "高風險 / 可能受限", possibly_supported: "需要進一步確認", unsupported: "不支援", supported: "完美支援", unknown: "未確認" },
    risk: { waiting: "等待檢測", checking: "檢測中", supported: "完美支援", blocked: "封號風險", high: "高危風險", light: "輕度風險" },
    valueMap: { "中国大陆 IP": "中國內地 IP", "访问和订阅风险极高": "訪問和訂閱風險極高" },
    confidence: { high: "高度疑似", medium: "疑似", low: "少量命中", safe: "環境安全，疑似", highRiskRegion: "高風險地區", supportedRegion: "官方支援地區" },
  },
  ru: {
    pending: "Ожидание проверки",
    unknown: "Неизвестно",
    signalLabels: {
      timezone: "Часовой пояс", language: "Язык браузера", languageVariant: "Языковые признаки", chineseFonts: "Региональные шрифты",
      vendorFonts: "Шрифты производителя", domesticBrowser: "Регион браузера", domesticDevice: "Регион устройства", locale: "Intl locale",
      timezoneOffset: "Смещение времени", emojiStyle: "Стиль Emoji", country: "Сетевой выход", proxyCountry: "Страна прокси",
      ipv4: "IPv4", browserIpLocation: "IP-локация", browserIpOrg: "Сетевая организация", os: "ОС",
      claudeReachability: "Доступность claude.ai из браузера", anthropicReachability: "Доступность сайта Anthropic",
      apiReachability: "Доступность Anthropic API", claudeTrigger: "Срабатывание Claude в браузере",
      claudeLatency: "Задержка Claude в браузере", webrtcSupport: "Поддержка WebRTC", webrtcCandidates: "Кандидаты WebRTC UDP",
      webrtcLeak: "Утечка публичного IP WebRTC", webrtcLeakCount: "Число утёкших IP", webrtcFirstIp: "Первый утёкший IP",
      webrtcRegion: "Риск региона утечки", webrtcConsistency: "Согласованность WebRTC и выхода",
      dnsMode: "Режим DNS", dnsReview: "Проверка пути DNS", dnsConsistency: "Сверка ответов DNS", gatewayProfile: "Браузер/приложение",
      deviceLineage: "Устройство/система", edgeCountry: "Страна края", edgeColo: "Colo Cloudflare", edgeCity: "Город края",
      edgeAsn: "ASN края", edgeOrg: "Сеть края", requestHeaders: "Полнота заголовков", httpLanguage: "HTTP-язык",
      secFetch: "Отпечаток Sec-Fetch", clientHints: "Отпечаток Client Hints", exitType: "Тип сетевого выхода", multiSourceConsistency: "Согласованность IP-источников",
      ipSourceCount: "Число IP-источников", countrySet: "Набор стран", ipCountryRisk: "Страна риска IP", claudeAccessRisk: "Риск доступа Claude",
      asn: "ASN", browser: "Браузер", device: "Устройство",
    },
    signalValues: {
      unknown: "Неизвестно", noBrands: "Нет UA-CH brands", noLanguageVariant: "Ключевые языковые признаки не найдены",
      simplifiedChinese: "Упрощенный китайский", traditionalChinese: "Традиционный китайский", scFonts: "Китайские шрифты", tcFonts: "Традиционные китайские шрифты",
      noFonts: "Ключевые региональные шрифты не найдены", vendorFontsFound: "Шрифты производителя найдены", noVendorFonts: "Шрифты производителя не найдены",
      domesticBrowserFound: "Китайский браузер найден", noDomesticBrowser: "Китайский браузер не найден",
      domesticDeviceFound: "Признаки китайского устройства", noDomesticDevice: "Ключевые признаки устройства не найдены",
      unknownBrowser: "Неизвестный браузер", unknownSystem: "Неизвестная система", wechatBrowser: "Встроенный браузер WeChat",
      androidDevice: "Android-устройство", linuxDevice: "Linux-устройство", appleEmoji: "Стиль Apple Emoji",
      androidEmoji: "Стиль Android / производителя", windowsEmoji: "Стиль Windows Emoji", unknownEmoji: "Неизвестный стиль Emoji",
      read: "Считано", webrtcSupported: "Поддерживается", webrtcUnsupported: "Не поддерживается", candidateUnit: "кандидатов",
      webrtcLeakFound: "Публичный IP найден", webrtcNoLeak: "Публичный IP не найден", webrtcRegionUnknown: "Нужны IP-данные",
      cannotDetermine: "Нужно сравнить IP выхода", notMeasured: "Не измерено", coreUnit: " ядер", touchUnit: " точек касания",
    },
    ipMetricLabels: { ipAddress: "IP-адрес", ipv6: "IPv6", ipv4: "IPv4", asn: "ASN", asnOwner: "Владелец ASN", company: "Компания", longitude: "Долгота", latitude: "Широта", ipType: "Тип IP", risk: "Риск", isp: "ISP" },
    regions: { auto: "Автоопределение", cn: "Китай", hk: "Гонконг", ru: "Россия", ir: "Иран" },
    status: { restricted: "Высокий риск / возможно ограничено", possibly_supported: "Нужно уточнение", unsupported: "Не поддерживается", supported: "Полная поддержка", unknown: "Не подтверждено" },
    risk: { waiting: "Ожидание", checking: "Проверка", supported: "Поддерживается", blocked: "Риск блокировки", high: "Высокий риск", light: "Низкий риск" },
    valueMap: { "中国大陆 IP": "IP материкового Китая", "访问和订阅风险极高": "Очень высокий риск доступа и подписки" },
    confidence: { high: "Высокая вероятность", medium: "Возможные признаки", low: "Небольшое совпадение", safe: "Среда выглядит безопасной:", highRiskRegion: "регион высокого риска", supportedRegion: "поддерживаемый регион" },
  },
  en: {
    pending: "Waiting",
    unknown: "Unknown",
    signalLabels: {
      timezone: "System timezone", language: "Browser language", languageVariant: "Language variant", chineseFonts: "Regional fonts",
      vendorFonts: "Vendor fonts", domesticBrowser: "Browser region traits", domesticDevice: "Device region traits", locale: "Intl locale",
      timezoneOffset: "Timezone offset", emojiStyle: "Emoji rendering style", country: "Network exit", proxyCountry: "Proxy exit country",
      ipv4: "IPv4", browserIpLocation: "IP location", browserIpOrg: "Network organization", os: "Operating system",
      claudeReachability: "claude.ai browser reachability", anthropicReachability: "Anthropic website browser reachability",
      apiReachability: "Anthropic API browser reachability", claudeTrigger: "Claude browser-side trigger",
      claudeLatency: "Claude browser-side latency", webrtcSupport: "WebRTC support", webrtcCandidates: "WebRTC UDP candidates",
      webrtcLeak: "WebRTC public IP leak", webrtcLeakCount: "WebRTC leaked IP count", webrtcFirstIp: "First WebRTC leaked IP",
      webrtcRegion: "WebRTC leak region risk", webrtcConsistency: "WebRTC / exit consistency",
      dnsMode: "DNS diagnostic mode", dnsReview: "DNS resolution path verification", dnsConsistency: "DNS reference cross-check", gatewayProfile: "Browser/app environment",
      deviceLineage: "Device/system signals", edgeCountry: "Edge country", edgeColo: "Cloudflare edge colo", edgeCity: "Edge city",
      edgeAsn: "Edge ASN", edgeOrg: "Edge network organization", requestHeaders: "Request header integrity", httpLanguage: "HTTP language preference",
      secFetch: "Sec-Fetch fingerprint", clientHints: "Client Hints fingerprint", exitType: "Network exit type", multiSourceConsistency: "IP source consistency",
      ipSourceCount: "IP intelligence sources", countrySet: "Multi-source country set", ipCountryRisk: "IP risk country", claudeAccessRisk: "Claude access risk",
      asn: "ASN", browser: "Browser", device: "Device environment",
    },
    signalValues: {
      unknown: "Unknown", noBrands: "No UA-CH brands", noLanguageVariant: "No key language variant detected",
      simplifiedChinese: "Simplified Chinese", traditionalChinese: "Traditional Chinese", scFonts: "Simplified Chinese fonts", tcFonts: "Traditional Chinese fonts",
      noFonts: "No key regional fonts detected", vendorFontsFound: "Vendor fonts detected", noVendorFonts: "No vendor fonts detected",
      domesticBrowserFound: "Domestic browser detected", noDomesticBrowser: "No domestic browser detected",
      domesticDeviceFound: "Domestic device traits detected", noDomesticDevice: "No key device traits detected",
      unknownBrowser: "Unknown browser", unknownSystem: "Unknown system", wechatBrowser: "WeChat in-app browser",
      androidDevice: "Android device", linuxDevice: "Linux device", appleEmoji: "Apple Emoji style",
      androidEmoji: "Android / vendor Emoji style", windowsEmoji: "Windows Emoji style", unknownEmoji: "Unknown Emoji style",
      read: "Read", webrtcSupported: "Supported", webrtcUnsupported: "Not supported", candidateUnit: "candidates",
      webrtcLeakFound: "Public IPs found", webrtcNoLeak: "No public IP found", webrtcRegionUnknown: "Needs IP intelligence",
      cannotDetermine: "Needs exit IP comparison", notMeasured: "Not measured", coreUnit: " cores", touchUnit: " touch points",
    },
    ipMetricLabels: { ipAddress: "IP address", ipv6: "IPv6", ipv4: "IPv4", asn: "ASN", asnOwner: "ASN owner", company: "Company", longitude: "Longitude", latitude: "Latitude", ipType: "IP type", risk: "Risk score", isp: "ISP" },
    regions: { auto: "Auto detect", cn: "Mainland China", hk: "Hong Kong", ru: "Russia", ir: "Iran" },
    status: { restricted: "High risk / possibly restricted", possibly_supported: "Needs confirmation", unsupported: "Unsupported", supported: "Fully supported", unknown: "Unconfirmed" },
    risk: { waiting: "Waiting", checking: "Checking", supported: "Fully supported", blocked: "Account risk", high: "High risk", light: "Light risk" },
    valueMap: { "中国大陆 IP": "Mainland China IP", "访问和订阅风险极高": "Very high access and subscription risk" },
    confidence: { high: "Highly likely", medium: "Likely", low: "Lightly matched", safe: "Environment looks safe, likely", highRiskRegion: "high-risk region", supportedRegion: "officially supported region" },
  },
};
