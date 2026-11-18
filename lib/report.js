/**
 * Repair log: a small in-memory ring buffer for the status endpoint plus a
 * best-effort JSONL mirror on disk so a failed repair can be read after the
 * Host restarted.
 *
 * The report lives under the DSH home (`~/.dsh/plugins-data/dsh-plugin-unlock/`),
 * never inside the profile package directory, and every write failure is
 * swallowed: logging must never be the reason a repair fails.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Directory the JSONL report is written to. */
export function reportDir() {
  return path.join(os.homedir(), '.dsh', 'plugins-data', 'dsh-plugin-unlock');
}

/** Path of the JSONL report file. */
export function reportFile() {
  return path.join(reportDir(), 'report.jsonl');
}

/**
 * Create the plugin's logger.
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
      /* the report is a convenience, never a requirement */
    }
    return record;
  };

  log.events = events;
  log.file = file;
  return log;
}
