// العامل الخلفي: طابور الإشعارات، الحملات المجدولة، الأتمتة، وانتهاء الصلاحيات.
import { fileURLToPath } from 'node:url';
import { processQueue } from './services/notifications.js';
import { runScheduledCampaigns } from './services/campaigns.js';
import { runAutomations, runMaintenance } from './services/automations.js';
import { loadSettings } from './services/settings.js';
import { config } from './config.js';
import { pool } from './db.js';

let running = false;
export async function runJobsOnce() {
  if (running) return { skipped: true };
  running = true;
  try {
    await loadSettings();
    const maintenance = await runMaintenance();
    const campaigns = await runScheduledCampaigns();
    const automations = await runAutomations();
    const sent = await processQueue();
    return { maintenance, campaigns, automations, sent };
  } finally {
    running = false;
  }
}

export function startWorker() {
  const tick = () => runJobsOnce().catch((e) => console.error('[worker]', e.message));
  setTimeout(tick, 3000);
  return setInterval(tick, config.workerIntervalSeconds * 1000);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--once')) {
    runJobsOnce().then((r) => { console.log(JSON.stringify(r, null, 2)); return pool.end(); });
  } else {
    console.log('Menzal worker started');
    startWorker();
  }
}
