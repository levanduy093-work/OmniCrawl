import { dialog } from 'electron';
import * as fs from 'node:fs';
import type { DesktopDatabase } from './database';

function csvCell(value: unknown) {
  let text = value === null || value === undefined
    ? ''
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export class ExportService {
  constructor(private readonly database: DesktopDatabase) {}

  async exportRun(runId: string, format: 'csv' | 'jsonl') {
    const run = this.database.getRun(runId);
    if (!run) throw new Error('Run not found');
    const items = this.database.getRunItems(runId);
    const result = await dialog.showSaveDialog({
      title: 'Xuất dữ liệu OmniCrawl',
      defaultPath: `omnicrawl-${run.actorName}-${run.id.slice(0, 8)}.${format}`,
      filters: format === 'csv'
        ? [{ name: 'CSV', extensions: ['csv'] }]
        : [{ name: 'JSON Lines', extensions: ['jsonl'] }]
    });
    if (result.canceled || !result.filePath) return null;

    if (format === 'jsonl') {
      const body = items.map((item) => JSON.stringify(item.data)).join('\n');
      fs.writeFileSync(result.filePath, body ? `${body}\n` : '', 'utf8');
      return result.filePath;
    }

    const columns = [...new Set(items.flatMap((item) => Object.keys(item.data)))];
    const rows = [
      columns.map(csvCell).join(','),
      ...items.map((item) => columns.map((column) => csvCell(item.data[column])).join(','))
    ];
    fs.writeFileSync(result.filePath, `\uFEFF${rows.join('\n')}\n`, 'utf8');
    return result.filePath;
  }
}
