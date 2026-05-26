import express from 'express';
import cors from 'cors';
import { init, db as fireDb } from './firebase.js';
import { startScheduler } from './handlers/scheduler.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

function uidFromReq(req) {
  const uid = req.headers['x-uid'];
  if (!uid) throw new Error('Missing x-uid header');
  return uid;
}

app.post('/api/send', async (req, res) => {
  try {
    const uid = uidFromReq(req);
    const {
      url, message, subject, degree, followupType, campaignId,
      personName, personTitle, campaignName,
      mf1, mf2, hasF1, hasF2,
      introMsg, f1Followup, f2Followup,
    } = req.body;

    if (!url || !message || !degree || !followupType || !campaignId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const nowTs = Date.now();
    const taskId = `ui_task_${nowTs}_${Math.random().toString(36).slice(2, 7)}`;
    const personKey =
      encodeURIComponent(url.split('?')[0].replace(/\/$/, '').replace(/^https?:\/\/(www\.)?/, ''))
        .replace(/%2F/g, '_').replace(/\./g, '_').replace(/-/g, '_').replace(/%/g, '_').substring(0, 100)
        + `_${nowTs}`;

    const is1st = degree.includes('1st');
    const isInMail = followupType === 'inmail' || followupType === 'inmail';
    const introName = isInMail ? 'InMail' : is1st ? 'Intro Message' : 'Connection Request';

    const payload = {
      id:  taskId,
      fId: taskId,
      action: 'SCHEDULE_TASK',
      at:  nowTs,
      n:   personName || '',
      u:   url,
      d:   degree,
      cn:  campaignName || campaignId,
      pk:  personKey,
      cId: campaignId,
      ti:  personTitle || '',
      cAt: nowTs,
      ft:  followupType,
      dp:  'now',
      st:  'queued',
      sAt: nowTs,
      dl:  0,
      m:   message,
      s:   subject || '',
    };

    const hasF1_ = hasF1 || (f1Followup ? 1 : 0);
    const hasF2_ = hasF2 || (f2Followup ? 1 : 0);
    const f1Msg = mf1 || f1Followup?.message || null;
    const f2Msg = mf2 || f2Followup?.message || null;

    if (hasF1_) {
      payload.mf1 = f1Msg;
      payload.hsf1 = 1;
      payload.pf1 = 0;
    }
    if (hasF2_) {
      payload.mf2 = f2Msg;
      payload.hsf2 = 1;
      payload.pf2 = 0;
    }
    if (isInMail) {
      payload.hsf1 = 0;
      payload.hsf2 = 0;
      delete payload.mf1;
      delete payload.mf2;
    }

    // Write to /trigger (extension reads from here)
    const triggerRef = fireDb().ref(`users/${uid}/trigger/${taskId}`);
    await triggerRef.set(payload);

    // Write to /tasks (server scheduler watches this)
    const taskRef = fireDb().ref(`users/${uid}/tasks/${taskId}`);
    await taskRef.set({
      action: isInMail ? 'inmail' : (is1st ? 'message' : 'connect'),
      url,
      message,
      subject: subject || '',
      degree,
      followupType: isInMail ? 'inmail' : followupType,
      campaignId,
      campaignName: campaignName || campaignId,
      personName: personName || '',
      personTitle: personTitle || '',
      status: 'pending',
      attemptCount: 0,
      createdAt: nowTs,
      mf1: f1Msg,
      mf2: f2Msg,
      hasF1: hasF1_,
      hasF2: hasF2_,
    });

    // Write /trigger_progress initial state (dashboard reads from here)
    const progressKey = isInMail ? 'im' : (is1st ? 'intro' : 'cr');
    const progressPatch = {};
    if (isInMail) {
      progressPatch[`trigger_progress/${personKey}/n`] = personName || '';
      progressPatch[`trigger_progress/${personKey}/cn`] = campaignName || campaignId;
      progressPatch[`trigger_progress/${personKey}/d`] = degree;
      progressPatch[`trigger_progress/${personKey}/url`] = url;
      progressPatch[`trigger_progress/${personKey}/im`] = 0;
      progressPatch[`trigger_progress/${personKey}/f1`] = -1;
      progressPatch[`trigger_progress/${personKey}/f2`] = -1;
      progressPatch[`trigger_progress/${personKey}/im_st`] = 'queued';
      progressPatch[`trigger_progress/${personKey}/f1_st`] = 'na';
      progressPatch[`trigger_progress/${personKey}/f2_st`] = 'na';
      progressPatch[`trigger_progress/${personKey}/im_sAt`] = nowTs;
      progressPatch[`trigger_progress/${personKey}/f1_sAt`] = null;
      progressPatch[`trigger_progress/${personKey}/f2_sAt`] = null;
      progressPatch[`trigger_progress/${personKey}/at`] = nowTs;
    } else {
      progressPatch[`trigger_progress/${personKey}/n`] = personName || '';
      progressPatch[`trigger_progress/${personKey}/cn`] = campaignName || campaignId;
      progressPatch[`trigger_progress/${personKey}/d`] = degree;
      progressPatch[`trigger_progress/${personKey}/url`] = url;
      progressPatch[`trigger_progress/${personKey}/${progressKey}`] = 0;
      progressPatch[`trigger_progress/${personKey}/f1`] = hasF1_ ? 0 : -1;
      progressPatch[`trigger_progress/${personKey}/f2`] = hasF2_ ? 0 : -1;
      progressPatch[`trigger_progress/${personKey}/i_st`] = 'queued';
      progressPatch[`trigger_progress/${personKey}/f1_st`] = hasF1_ ? 'waiting' : 'na';
      progressPatch[`trigger_progress/${personKey}/f2_st`] = hasF2_ ? 'waiting' : 'na';
      progressPatch[`trigger_progress/${personKey}/i_sAt`] = nowTs;
      progressPatch[`trigger_progress/${personKey}/f1_sAt`] = hasF1_ ? nowTs : null;
      progressPatch[`trigger_progress/${personKey}/f2_sAt`] = null;
      progressPatch[`trigger_progress/${personKey}/at`] = nowTs;
    }
    await fireDb().ref(`users/${uid}`).update(progressPatch);

    // Track in campaign metadata
    const campaignRef = fireDb().ref(`users/${uid}/campaigns/${campaignId}`);
    const snap = await campaignRef.once('value');
    const campaign = snap.val() || { name: campaignName || personName || url, createdAt: nowTs, cancelled: false };
    const ft = isInMail ? 'inmail' : followupType;
    campaign[`${ft}TaskId`] = taskId;
    campaign[`${ft}Status`] = 'pending';
    campaign[`${ft}ScheduledAt`] = nowTs;
    await campaignRef.set(campaign);

    console.log(`[SEND] ${uid} / ${followupType} / ${taskId} → queued`);
    res.json({ ok: true, taskId, personKey });
  } catch (e) {
    console.error('[SEND] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/status', async (req, res) => {
  try {
    const uid = uidFromReq(req);
    const { data } = req.body;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'Missing data object' });
    }
    await fireDb().ref(`users/${uid}`).update(data);
    res.json({ ok: true });
  } catch (e) {
    console.error('[STATUS] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/cancel/:campaignId', async (req, res) => {
  try {
    const uid = uidFromReq(req);
    const { campaignId } = req.params;
    await fireDb().ref(`users/${uid}/campaigns/${campaignId}`).update({ cancelled: true });
    console.log(`[CANCEL] ${uid} / ${campaignId}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[CANCEL] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => {
  res.json({ service: 'Driply Scheduler', ok: true, docs: '/api/health' });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

init();
startScheduler();

app.listen(PORT, () => {
  console.log(`[SERVER] Driply Scheduler running on port ${PORT}`);
});
