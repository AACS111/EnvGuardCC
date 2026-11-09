"use client";

import { useEffect, useRef } from 'react';
import type { LocaleCode } from '@/i18n/messages';
import { WorkspaceIcon } from './WorkspaceIcon';
import { isDialogBackdropEvent } from './RepairDialog';

const REPOSITORY = 'https://github.com/AACS111/EnvGuardCC';

// 面向使用者的简版文档：只描述可见界面与公开行为，不写入本机端口、内部路径或凭据。
export function DocumentationDialog({ locale, onClose }: { locale: LocaleCode; onClose: () => void }) {
  const zh = locale.startsWith('zh');
  const text = (cn: string, en: string) => zh ? cn : en;
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPointerDown = useRef(false);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!element.open) element.showModal();
    return () => {
      if (element.open) element.close();
      previousFocus?.focus({ preventScroll: true });
    };
  }, []);

  const steps = [
    { title: text('启动本机服务', 'Start the local service'), detail: text('按仓库 README 启动桌面应用或本地服务，顶栏显示「本机服务已连接」后再继续。', 'Launch the desktop app or the local service as described in the README; wait until the header shows “Local service connected”.') },
    { title: text('配置出口', 'Set up an exit'), detail: text('打开「网络 → 网络设置」，添加订阅、配置文件、手工节点或本机代理，并选中要使用的节点。', 'Open Network → Network settings, add a subscription, configuration file, manual node or local proxy, and select the node to use.') },
    { title: text('运行检测', 'Run checks'), detail: text('点顶部「检测」。先在「概览」看两组得分，再到「测试项目」查看每一项的实测值、判定与原因。', 'Select Check in the header. Review the two scores under Overview, then open Test items for each measured value, verdict and reason.') },
    { title: text('按需开启保护', 'Enable protection if needed'), detail: text('点「启动环境防护」应用可回滚设置，再用「启动保护浏览器」打开 Claude。关闭防护会恢复原有配置。', 'Select Start environment protection to apply reversible settings, then Launch protected browser to use Claude. Stopping protection restores the previous configuration.') },
  ];

  const pages = [
    { name: text('概览', 'Overview'), detail: text('防护状态、浏览器与客户端得分、当前出口、目标环境、浏览器保护和待关注项；异常按「可保护 / 保护范围外」分开展示。', 'Protection state, browser and client scores, current exit, target environment, browser protection and items that need attention. Issues are split into protectable and outside protection.') },
    { name: text('网络', 'Network'), detail: text('代理范围（规则 / 全局 / 其他直连）、出口节点、测速与出口检测、传输记录、连接保护和出口稳定性。', 'Proxy scope (Rule / Global / Others direct), exit nodes, latency and exit probes, transfer log, connection protection and exit stability.') },
    { name: text('测试项目', 'Test items'), detail: text('检测目录与每项依据；可按全部 / 异常 / 未判定 / 通过筛选、搜索，点条目查看详情并做单项处理。', 'The full test catalog with evidence. Filter by All / Issues / Unresolved / Passed, search, and open an item for details and single-item actions.') },
    { name: text('保护对比', 'Comparison'), detail: text('对比启动保护前后的采样：已检测到的变化、仍需关注、缺少基线和未变化项目。', 'Compare samples before and after protection: observed changes, items still needing attention, missing baselines and unchanged items.') },
    { name: text('设置', 'Settings'), detail: text('自动检测开关与间隔、开机自启、Claude 恢复初始化、运行提醒，以及网络和高级选项。', 'Automatic checks and interval, launch at login, Claude reset, runtime notices, plus network and advanced options.') },
    { name: text('检查更新', 'Updates'), detail: text('左下角显示当前版本，有匹配安装包的新正式版本时提示「可更新」；点击可查看版本说明和下载入口。', 'The lower-left corner shows the current version and flags a newer stable release when a matching download is ready. Open it for release notes and downloads.') },
  ];

  const actions = [
    { name: text('检测', 'Check'), detail: text('重新采样当前环境，不修改系统设置；检测期间按钮显示「检测中…」。', 'Re-samples the current environment without changing system settings; shows “Checking…” while running.') },
    { name: text('启动 / 关闭环境防护', 'Start / Stop protection'), detail: text('应用或恢复时区、语言、区域等可回滚设置；关闭时从备份恢复，不影响保护范围外的项。', 'Applies or restores reversible timezone, language and region settings from a backup; items outside the protection scope are untouched.') },
    { name: text('启动保护浏览器', 'Launch protected browser'), detail: text('用独立配置启动受管浏览器，沿用当前环境画像；「选择浏览器」决定接入哪一个浏览器。', 'Starts a managed browser in its own profile with the current environment profile. “Choose browser” selects which browser to link.') },
    { name: text('管理网络 / 网络设置', 'Manage network / Network settings'), detail: text('管理配置来源、出口节点、代理范围和连接保护。', 'Manage configuration sources, exit nodes, proxy scope and connection protection.') },
    { name: text('测速 / 检测出口', 'Measure / Probe exits'), detail: text('前者测量节点延迟，后者查询节点实际出口 IP 与地区；结果只作为判断依据，不按节点名称推断。', 'Measure node latency, or query each node’s actual exit IP and region. Results are measured evidence; node names are not used to infer exits.') },
    { name: text('复检路由 / 刷新', 'Recheck routing / Refresh'), detail: text('复检按当前节点重新验证连接路径；刷新重新采集出口与环境数据。', 'Recheck re-verifies the connection path for the selected node; Refresh re-samples exit and environment data.') },
    { name: text('查看检测结果', 'View results'), detail: text('「查看检测结果 / 查看全部 / 查看检测项」都会跳到「测试项目」并套用相应筛选。', '“View results / View all / View test items” jump to Test items with the matching filter applied.') },
    { name: text('检查更新 / 下载新版本', 'Check updates / Download update'), detail: text('启动后自动检查，每 6 小时复查 GitHub 正式版本，也可手动重查。下载后请先正常退出应用，等待配置恢复，再安装。', 'Checks GitHub stable releases at startup and every 6 hours, with manual rechecks available. After downloading, quit normally and wait for restoration before installing.') },
  ];

  const boundaries = [
    { name: text('本地优先', 'Local-first'), detail: text('项目没有自建云端服务，配置、订阅和检测结果保存在本机；代码可自行审查和部署。', 'The project has no hosted backend. Configuration, subscriptions and results stay on your machine, and the code can be reviewed and self-hosted.') },
    { name: text('必要的外部请求', 'Required network requests'), detail: text('检测会访问你配置的出口节点、公开的 IP / 地区查询接口和 Claude 站点；保护模式会按你的配置代理 Claude 流量。', 'Checks contact your configured exit nodes, public IP/region lookup services and Claude sites; protection proxies Claude traffic according to your configuration.') },
    { name: text('系统授权', 'System authorization'), detail: text('开启「系统流量接管」或严格连接保护时，系统可能要求一次管理员授权；本地助手只接受启动、停止、重启这类固定动作，之后可用安装器卸载。', 'Enabling system traffic capture or strict connection protection may require one administrator authorization. The local helper accepts only fixed start/stop/restart actions and can be removed with the installer later.') },
    { name: text('检测范围有限', 'Limited scope'), detail: text('得分只反映本次采样；系统字体 / Emoji、节点质量和 Claude 服务端策略等不在保护范围内。', 'Scores reflect this sample only. System fonts/emoji, node quality and server-side policies are outside the protection scope.') },
    { name: text('不替代账号安全', 'Not a substitute for account safety'), detail: text('本项目不提供账号、订阅或代理节点，也不保证登录、订阅或账号状态；使用时应遵守 Claude 的服务条款。', 'The project provides no accounts, subscriptions or proxy nodes, and cannot guarantee login, subscription or account status. Use it in line with Claude’s terms.') },
    { name: text('提交 Issue 前', 'Before filing an issue'), detail: text('请先移除订阅链接、API Key、账号信息和其他个人数据；截图和日志注意打码。', 'Remove subscription links, API keys, account details and other personal data first; redact screenshots and logs.') },
  ];

  return <dialog ref={dialog} className="repair-dialog workspace-docs" aria-labelledby="workspace-docs-title" aria-describedby="workspace-docs-description"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onPointerDown={event => { backdropPointerDown.current = isDialogBackdropEvent(event); }}
    onClick={event => { if (backdropPointerDown.current && isDialogBackdropEvent(event)) onClose(); backdropPointerDown.current = false; }}>
    <header className="repair-dialog__header">
      <div><h2 id="workspace-docs-title"><WorkspaceIcon name="document" />{text('使用文档', 'Documentation')}</h2><p id="workspace-docs-description">{text('从检测到保护，快速了解 EnvGuardCC', 'From checks to protection: a quick guide to EnvGuardCC')}</p></div>
      <button type="button" className="repair-button repair-button--quiet" onClick={onClose} aria-label={text('关闭使用文档', 'Close documentation')}>×</button>
    </header>
    <div className="repair-dialog__body workspace-docs__body">
      <section className="workspace-docs__intro">
        <h3>{text('在本机检查并整理 Claude 的环境画像', 'Inspect and align your Claude environment locally')}</h3>
        <p>{text('EnvGuardCC 是一个开源、本地运行的 Claude 环境自查与保护工具。它对照目标地区检查浏览器和 Claude 客户端暴露的信号——时区、语言、区域、字体、出口 IP 等——给出加权得分、判定依据和可处理的异常；需要时可以应用可回滚的环境保护，并用受管浏览器访问 Claude。', 'EnvGuardCC is an open-source, local-first checker and protection tool for Claude environments. It compares the signals exposed by your browser and Claude client — timezone, language, region, fonts, exit IP and more — against a target region, showing weighted scores, evidence and actionable issues. When needed, it applies reversible protection and opens Claude in a managed browser.')}</p>
        <div className="workspace-docs__chips"><span className="workspace-docs__chip">{text('开源 · MIT', 'Open source · MIT')}</span><span className="workspace-docs__chip">{text('本地运行', 'Local-first')}</span><span className="workspace-docs__chip">{text('可回滚保护', 'Reversible protection')}</span></div>
        <p className="workspace-docs__hint">{text('得分只用于自查，不等于封禁概率；本项目不提供账号、订阅或代理节点。', 'Scores are for self-checking only, not a ban probability. The project provides no accounts, subscriptions or proxy nodes.')}</p>
      </section>

      <section className="workspace-docs__section" aria-labelledby="workspace-docs-quickstart">
        <h3 id="workspace-docs-quickstart">{text('快速开始', 'Quick start')}</h3>
        <ol className="workspace-docs__steps">{steps.map(step => <li key={step.title}><strong>{step.title}</strong><span>{step.detail}</span></li>)}</ol>
      </section>

      <section className="workspace-docs__section" aria-labelledby="workspace-docs-pages">
        <h3 id="workspace-docs-pages">{text('页面说明', 'Pages')}</h3>
        <dl className="workspace-docs__list">{pages.map(page => <div key={page.name} className="workspace-docs__row"><dt>{page.name}</dt><dd>{page.detail}</dd></div>)}</dl>
      </section>

      <section className="workspace-docs__section" aria-labelledby="workspace-docs-actions">
        <h3 id="workspace-docs-actions">{text('常用按钮', 'Common actions')}</h3>
        <dl className="workspace-docs__list">{actions.map(action => <div key={action.name} className="workspace-docs__row workspace-docs__row--action"><dt>{action.name}</dt><dd>{action.detail}</dd></div>)}</dl>
      </section>

      <section className="workspace-docs__section" aria-labelledby="workspace-docs-boundaries">
        <h3 id="workspace-docs-boundaries">{text('边界与隐私', 'Scope and privacy')}</h3>
        <dl className="workspace-docs__list">{boundaries.map(item => <div key={item.name} className="workspace-docs__row"><dt>{item.name}</dt><dd>{item.detail}</dd></div>)}</dl>
      </section>

      <footer className="workspace-docs__foot">
        <span>{text('MIT 许可 · 文档随版本更新；这是简版说明，截图与常见问题后续补充。', 'MIT licensed · Updated with releases. This is a quick guide; screenshots and FAQ will be added later.')}</span>
        <a className="repair-button" href={REPOSITORY} target="_blank" rel="noreferrer"><WorkspaceIcon name="github" />{text('项目地址', 'Repository')} →</a>
      </footer>
    </div>
  </dialog>;
}
