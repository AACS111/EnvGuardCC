// EnvGuardCC 的全站布局入口，用于声明 SEO 元信息、全局样式、统计脚本和页面根结构。
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://github.com/AACS111/EnvGuardCC"),
  title: {
    default: "EnvGuardCC",
    template: "%s｜EnvGuardCC",
  },
  description: "独家 AI 环境指纹引擎，综合扫描 Claude 运行环境、地区画像与账号风险",
  alternates: {
    canonical: "/",
    languages: {
      "zh-CN": "/",
      "zh-HK": "/hong-kong",
      ru: "/russia",
      en: "/en",
    },
  },
  openGraph: {
    type: "website",
    url: "https://github.com/AACS111/EnvGuardCC",
    siteName: "EnvGuardCC",
    title: "EnvGuardCC · 环境检测",
    description: "独家 AI 环境指纹引擎，综合扫描 Claude 运行环境、地区画像与账号风险",
    locale: "zh_CN",
  },
  twitter: {
    card: "summary_large_image",
    title: "EnvGuardCC · 环境检测",
    description: "独家 AI 环境指纹引擎，综合扫描 Claude 运行环境、地区画像与账号风险",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
