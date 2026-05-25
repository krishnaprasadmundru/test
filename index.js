import express from 'express';
import cors from 'cors';
import { init, db, auth } from './firebase.js';
import { startScheduler } from './handlers/scheduler.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

function uidFromReq(req) {
  const uid = req.headers['x-uid'];
  if (!uid) throw new Error('Missing x-uid header');
  return uid;
}

app.post('/api/send', async (req, res) => {
  try {
    const uid = uidFromReq(req);
    const { url, message, degree, followupType, campaignId, personName, personTitle } = req.body;

    if (!url || !message || !degree || !followupType || !campaignId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    const task = {
      action: degree === '1st' ? 'message' : 'connect',
      url,
      message,
      degree,
      followupType,
      campaignId,
      personName: personName || '',
      personTitle: personTitle || '',
      status: 'pending',
      attemptCount: 0,
      createdAt: now,
    };

    const ref = db().ref(`users/${uid}/tasks/${taskId}`);
    await ref.set(task);

    // Track in campaign
    const campaignRef = db().ref(`users/${uid}/campaigns/${campaignId}`);
    const snap = await campaignRef.once('value');
    const campaign = snap.val() || { name: personName || url, createdAt: now, cancelled: false };

    if (followupType === 'intro') campaign.introTaskId = taskId;
    else if (followupType === 'f1') campaign.f1TaskId = taskId;
    else if (followupType === 'f2') campaign.f2TaskId = taskId;

    campaign[`${followupType}Status`] = 'pending';
    campaign[`${followupType}ScheduledAt`] = now;
    await campaignRef.set(campaign);

    console.log(`[SEND] ${uid} / ${followupType} / ${taskId} → pending`);
    res.json({ ok: true, taskId });
  } catch (e) {
    console.error('[SEND] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/cancel/:campaignId', async (req, res) => {
  try {
    const uid = uidFromReq(req);
    const { campaignId } = req.params;

    const campaignRef = db().ref(`users/${uid}/campaigns/${campaignId}`);
    await campaignRef.update({ cancelled: true });

    console.log(`[CANCEL] ${uid} / ${campaignId}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[CANCEL] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

init();
startScheduler();

app.listen(PORT, () => {
  console.log(`[SERVER] Driply Scheduler running on port ${PORT}`);
});
