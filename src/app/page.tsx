import type { Metadata } from "next";
import { Detector } from "@/components/detector/Detector";
import type { LocaleCode } from "@/i18n/messages";
export const metadata: Metadata = { title: { absolute: "EnvGuardCC" }, description: "环境检测、模拟保护与配置对比" };
export function HomeContent({ locale = "zh" }: { locale?: LocaleCode }) {
  return <main className="check-workspace"><Detector locale={locale} /></main>;
}
export default function Home() { return <HomeContent />; }
