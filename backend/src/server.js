const { createApp } = require('./app');
const { reconcile } = require('./service');
const { migrate } = require('./migrate');

// Deployment mode: run the bundled mock operator inside this same process (START_MOCK=true)
if (process.env.START_MOCK === 'true') require('../../mock-operator/server');

const port = Number(process.env.PORT || 3000);

migrate() // idempotent: creates tables / seeds wallet if missing
  .then(() => {
    createApp().listen(port, () => console.log(`API on http://localhost:${port}`));

    // Background reconciliation job. Safe to overlap across instances because settle() is idempotent.
    let running = false;
    setInterval(async () => {
      if (running) return;
      running = true;
      try {
        const report = await reconcile();
        if (report.length) console.log('[reconcile]', JSON.stringify(report));
      } catch (e) { console.error('[reconcile] failed', e.message); }
      finally { running = false; }
    }, Number(process.env.RECON_INTERVAL_SEC || 10) * 1000);
  })
  .catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
