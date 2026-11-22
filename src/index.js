import { createApp } from './server.js';
import { config } from './config.js';
import { loadSettings } from './services/settings.js';
import { migrate } from '../scripts/migrate.js';
import { startWorker } from './worker.js';

await migrate({ quiet: true });
await loadSettings();
createApp().listen(config.port, () => console.log(`منزال | نظام الولاء يعمل على ${config.appUrl}`));
if (config.runWorker) startWorker();
