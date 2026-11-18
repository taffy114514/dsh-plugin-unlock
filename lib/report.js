/**
 * 修复日志：一个给 status 接口用的小型内存环形缓冲，外加磁盘上的 JSONL 镜像，
 * 这样宿主重启之后仍然能读到上一次失败到底卡在哪。
 *
 * 报告写在 DSH 家目录下（`~/.dsh/plugins-data/dsh-plugin-unlock/`），绝不写进
 * profile 的包目录；所有写盘失败都被吞掉——记日志永远不该成为修复失败的原因。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** JSONL 报告写到的目录。 */
export function reportDir() {
  return path.join(os.homedir(), '.dsh', 'plugins-data', 'dsh-plugin-unlock');
}

/** JSONL 报告文件路径。 */
export function reportFile() {
  return path.join(reportDir(), 'report.jsonl');
}

/**
 * 造出插件的日志器。
 * @param {{log?: boolean, maxLogEvents?: number}} config
 */
export function createReportLog(config) {
  const events = [];
  const max = Math.max(1, config?.maxLogEvents ?? 50);
  const enabled = config?.log !== false;
  const file = reportFile();

  /** @param {string} event @param {Record<string, unknown>} [detail] */
  const log = (event, detail) => {
    const record = {
      time: new Date().toISOString(),
      event,
      ...(detail && typeof detail === 'object' ? detail : {}),
    };
    events.push(record);
    while (events.length > max) events.shift();
    if (!enabled) return record;
    try {
      fs.mkdirSync(reportDir(), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      /* 报告只是顺手，不是必需品 */
    }
    return record;
  };

  log.events = events;
  log.file = file;
  return log;
}
