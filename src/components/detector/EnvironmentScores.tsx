import type { LocaleCode } from "@/i18n/messages";
import type { SimulationJob } from "@/detection/simulation";

export function environmentScoreCopy(locale: LocaleCode) {
  if (locale.startsWith("zh")) return {
    title: "综合环境指数", browser: "浏览器", claude: "Claude 网关", combined: "综合",
    heading: "两侧环境指数", unit: "/100", pending: "未检测", sampled: "浏览器已采样",
    verified: "模拟请求已通过", unverified: "模拟请求待执行", offline: "网关未连接",
    simulation: { idle: "模拟请求待执行", running: "模拟请求执行中", passed: "模拟请求已通过", failed: "模拟请求未通过", stale: "配置已变更，待重新自检", unknown: "自检连接异常" },
    scoreNote: "规则加分，越高表示命中的信号越多；不是封号概率。",
    zeroNote: "0 分仅表示当前已测项未加分，不代表账号安全或充值获准。",
    combinedNote: "综合分：同一项取两侧较高分后加总，最高 100 分。",
    compareNote: "仅比较两侧均有实测依据的项目。值不同不等于风险；等待请求和不适用项不计入差异。",
    notApplicable: "不适用 · 不比较", unknown: "未验证 · 不比较", different: "采样值不同",
    timezoneNote: "浏览器列为系统采样；网关列仅为出口配置参考，不表示已修改系统或 Claude 远端时区。",
    listNote: "仅浏览器项目展示浏览器采样；其余项目优先展示客户端结果，模拟采样单独标注。浏览器原始加分仍计入浏览器指数。",
  };
  if (locale === "ru") return {
    title: "Сводный индекс среды", browser: "Браузер", claude: "Шлюз Claude", combined: "Сводный",
    heading: "Индексы двух сред", unit: "/100", pending: "Не проверено", sampled: "Браузер измерен",
    verified: "Симуляция пройдена", unverified: "Симуляция не выполнена", offline: "Шлюз недоступен",
    simulation: { idle: "Симуляция не выполнена", running: "Симуляция выполняется", passed: "Симуляция пройдена", failed: "Симуляция не пройдена", stale: "Повторите симуляцию", unknown: "Нет связи с симуляцией" },
    scoreNote: "Баллы правил: выше — больше сигналов. Это не вероятность блокировки.",
    zeroNote: "0 означает отсутствие баллов в измеренных данных, а не безопасность аккаунта или разрешение оплаты.",
    combinedNote: "По каждому сигналу берётся больший балл двух сред; сумма ограничена 100.",
    compareNote: "Сравниваются только измеренные данные. Различие не означает риск. Неизмеренные и неприменимые данные исключены.",
    notApplicable: "Неприменимо", unknown: "Не подтверждено", different: "Разные значения",
    timezoneNote: "Браузер показывает системное измерение; шлюз — только целевую настройку, не часовой пояс серверов Claude.",
    listNote: "Пункты только браузера показывают его данные; остальные — данные клиента. Симуляция отмечена отдельно; баллы браузера сохраняются.",
  };
  return {
    title: "Combined environment index", browser: "Browser", claude: "Claude gateway", combined: "Combined",
    heading: "Environment indices", unit: "/100", pending: "Not checked", sampled: "Browser sampled",
    verified: "Simulated requests passed", unverified: "Simulation not run", offline: "Gateway offline",
    simulation: { idle: "Simulation not run", running: "Simulation running", passed: "Simulated requests passed", failed: "Simulation failed", stale: "Rerun simulation", unknown: "Simulation connection failed" },
    scoreNote: "Heuristic points: higher means more flagged signals. This is not a ban probability.",
    zeroNote: "0 means measured signals add no points; it does not confirm account safety or payment eligibility.",
    combinedNote: "Take the higher value per signal across both environments, then sum, capped at 100.",
    compareNote: "Compare measured evidence only. Different values do not imply risk; unverified and inapplicable items are excluded.",
    notApplicable: "Not applicable", unknown: "Unverified", different: "Different samples",
    timezoneNote: "Browser: system sample. Gateway: configured exit target only, not a changed system or Claude server timezone.",
    listNote: "Browser-only cards keep browser samples; other cards prefer client results and label simulation. Original browser points remain in its index.",
  };
}

type Props = {
  browser: number | null;
  claude: number | null;
  combined: number | null;
  claudeAttempted: boolean;
  simulationState: SimulationJob["state"] | "unknown";
  locale: LocaleCode;
};

export function EnvironmentScores({ browser, claude, combined, claudeAttempted, simulationState, locale }: Props) {
  const copy = environmentScoreCopy(locale);
  const severity = (score: number | null) => score === null ? "pending" : score > 0 ? "flagged" : "measured";
  const claudeStatus = claude === null ? claudeAttempted ? copy.offline : copy.pending : copy.simulation[simulationState];
  return (
    <figure className="environment-scores" aria-label={copy.heading}>
      <figcaption>{copy.heading}</figcaption>
      <div className="environment-scores__bars">
        {([{ key: "browser", label: copy.browser, value: browser }, { key: "claude", label: copy.claude, value: claude }] as const).map(({ key, label, value }) => (
          <div className="environment-scores__bar" key={key} data-environment={key} data-severity={severity(value)}>
            <div className="environment-scores__bar-heading">
              <span>{label}</span><strong>{value ?? "—"}<small>{copy.unit}</small></strong>
            </div>
            {value === null ? (
              <div className="environment-scores__track environment-scores__track--pending"><span>{copy.pending}</span></div>
            ) : (
              <div className="environment-scores__track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-valuetext={value + copy.unit}>
                <span className="environment-scores__marker" style={{ left: Math.min(100, Math.max(0, value)) + "%" }} />
              </div>
            )}
            <div className="environment-scores__ticks" aria-hidden="true">{[0, 25, 50, 75, 100].map(tick => <span key={tick}>{tick}</span>)}</div>
          </div>
        ))}
      </div>
      <div className="environment-scores__combined" data-environment="combined">
        <span>{copy.combined}</span><strong>{combined ?? "—"}<small>{copy.unit}</small></strong>
      </div>
      <dl className="environment-scores__states">
        <div><dt>{copy.browser}</dt><dd>{browser === null ? copy.pending : copy.sampled}</dd></div>
        <div><dt>{copy.claude}</dt><dd data-simulation-passed={claude !== null && simulationState === "passed"}>{claudeStatus}</dd></div>
      </dl>
      <p>{copy.scoreNote}</p>
      <p>{copy.combinedNote}</p>
      <p>{copy.zeroNote}</p>
    </figure>
  );
}
