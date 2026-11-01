// Returns true only when the user asks the application to retry its normal shutdown.
export async function showTrafficRecoveryDialog({ dialog, error, getStatus, request }) {
  let status;
  try { status = await getStatus(); } catch { status = {}; }
  const recovery = status.recovery ?? {};
  const details = [error.message];
  if (['FLCLASH_MERGE_AVAILABLE', 'FLCLASH_CONFLICT'].includes(error.code) && recovery.changes?.length) details.push('已变化的字段：\n' + recovery.changes.slice(0, 12).map(change => `• ${change.path}（${({ added: '新增', removed: '移除', modified: '修改' })[change.change]}${change.before !== undefined || change.after !== undefined ? `：${change.before ?? '—'} → ${change.after ?? '—'}` : ''}）`).join('\n') + (recovery.changes.length > 12 ? '\n更多字段可在应用中查看。' : ''));
  if (recovery.backupDir) details.push('备份位置：' + recovery.backupDir);
  const detail = details.join('\n\n');
  const showFailure = async failure => dialog.showMessageBox({ type: 'error', title: '操作未完成', message: failure.message, buttons: ['返回'] });

  if (error.code === 'FLCLASH_MERGE_AVAILABLE' && (recovery.kind !== 'merge' || !recovery.fingerprint)) {
    await dialog.showMessageBox({ type: 'warning', title: '需要重新检查配置', message: '无法读取当前恢复方案。请返回应用，刷新 FlClash 状态后重试。', detail, buttons: ['返回应用'] });
    return false;
  }

  if (error.code === 'FLCLASH_MERGE_AVAILABLE' && recovery.kind === 'merge' && recovery.fingerprint) {
    for (;;) {
      const buttons = ['保留更改并解除联动', ...(recovery.backupDir ? ['打开备份'] : []), '返回应用'];
      const { response } = await dialog.showMessageBox({ type: 'warning', title: 'FlClash 配置已变化', message: '可以保留当前修改，只解除 EnvGuardCC 联动。', detail, buttons, cancelId: buttons.length - 1, noLink: true });
      if (response === buttons.length - 1) return false;
      try {
        if (response === 0) { await request('restore-preserving-changes', { fingerprint: recovery.fingerprint }); return true; }
        await request('open-recovery-backup');
      } catch (failure) { await showFailure(failure); return false; }
    }
  }

  if (error.code === 'FLCLASH_CONFLICT') {
    for (;;) {
      const buttons = [
        ...(recovery.backupDir ? ['打开备份'] : []),
        ...(recovery.kind === 'conflict' && recovery.originalValid && recovery.fingerprint ? ['恢复联动前备份'] : []),
        '打开 FlClash', '返回应用',
      ];
      const { response } = await dialog.showMessageBox({ type: 'warning', title: '需要检查 FlClash 配置', message: '当前配置无法安全地自动恢复，已有修改不会被覆盖。', detail, buttons, cancelId: buttons.length - 1, noLink: true });
      const selected = buttons[response];
      if (selected === '返回应用') return false;
      try {
        if (selected === '恢复联动前备份') {
          const confirmation = await dialog.showMessageBox({ type: 'warning', title: '确认恢复联动前备份', message: '这会替换当前配置，联动之后的修改将不再生效。当前配置会先备份。', buttons: ['恢复备份', '取消'], defaultId: 1, cancelId: 1, noLink: true });
          if (confirmation.response === 0) { await request('restore-original', { fingerprint: recovery.fingerprint, confirm: true }); return true; }
        } else if (selected === '打开备份') await request('open-recovery-backup');
        else if (selected === '打开 FlClash') await request('open-flclash');
      } catch (failure) { await showFailure(failure); return false; }
    }
  }

  for (;;) {
    const { response } = await dialog.showMessageBox({ type: 'warning', title: '完成 FlClash 恢复后退出', message: '请打开 FlClash，重新应用并启动当前配置，然后检查并退出。', detail, buttons: ['打开 FlClash', '检查并退出', '返回应用'], cancelId: 2, noLink: true });
    if (response === 2) return false;
    if (response === 1) return true;
    try { await request('open-flclash'); } catch (failure) { await showFailure(failure); }
  }
}
