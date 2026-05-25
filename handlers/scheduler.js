import { db } from '../firebase.js';

const FOLLOWUP_DELAY_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const MAX_RETRY_ATTEMPTS = 3;
const ACK_TIMEOUT_MS = 60_000; // 1 min

// uid -> Map<timerId, timeoutHandle>
const activeTimers = new Map();

// ── Start watching RTDB ──────────────────────────────────────────────────

export function startScheduler() {
  const rootRef = db().ref('users');

  rootRef.on('child_added', (snap) => {
    const uid = snap.key;
    watchUserTasks(uid);
    recoverTimers(uid);
  });

  rootRef.on('child_changed', (snap) => {
    const uid = snap.key;
    watchUserTasks(uid);
  });

  // Also check existing users on startup
  rootRef.once('value', (snap) => {
    if (!snap.val()) return;
    snap.forEach((child) => {
      const uid = child.key;
      watchUserTasks(uid);
      recoverTimers(uid);
    });
  });

  console.log('[SCHEDULER] Started watching RTDB');
}

// ── Watch tasks for a user ───────────────────────────────────────────────

function watchUserTasks(uid) {
  const tasksRef = db().ref(`users/${uid}/tasks`);

  // Listen for new/changed tasks
  tasksRef.on('child_changed', async (snap) => {
    const task = snap.val();
    if (!task) return;
    await handleTaskStatus(uid, snap.key, task);
  });

  // Also handle initial load
  tasksRef.once('value', (snap) => {
    if (!snap.val()) return;
    snap.forEach((child) => {
      const task = child.val();
      if (task && task.status === 'completed') {
        handleTaskStatus(uid, child.key, task);
      }
    });
  });
}

// ── Handle task status changes ──────────────────────────────────────────

async function handleTaskStatus(uid, taskId, task) {
  if (task.cancelled) return;

  switch (task.status) {
    case 'pending': {
      // Set ack timeout
      scheduleTask(uid, taskId, task, ACK_TIMEOUT_MS, () => {
        handleAckTimeout(uid, taskId);
      });
      break;
    }

    case 'acknowledged': {
      // Extension picked it up — cancel ack timeout, wait for result
      cancelTaskTimer(uid, taskId);
      break;
    }

    case 'completed': {
      cancelTaskTimer(uid, taskId);
      await handleTaskCompleted(uid, taskId, task);
      break;
    }

    case 'failed': {
      cancelTaskTimer(uid, taskId);
      await handleTaskFailed(uid, taskId, task);
      break;
    }
  }
}

// ── Ack timeout ──────────────────────────────────────────────────────────

function handleAckTimeout(uid, taskId) {
  console.log(`[TIMEOUT] ${uid}/${taskId} not acknowledged — re-write`);
  const ref = db().ref(`users/${uid}/tasks/${taskId}`);
  ref.once('value').then((snap) => {
    const task = snap.val();
    if (!task || task.status !== 'pending') return;
    // Re-set to trigger extension again
    ref.update({ status: 'pending' });
  });
}

// ── Task completed → schedule follow-up ─────────────────────────────────

async function handleTaskCompleted(uid, taskId, task) {
  if (task.followupType === 'intro') {
    await scheduleFollowup(uid, task, 'f1');
  } else if (task.followupType === 'f1') {
    await scheduleFollowup(uid, task, 'f2');
  }
}

async function scheduleFollowup(uid, task, nextType) {
  const campaignRef = db().ref(`users/${uid}/campaigns/${task.campaignId}`);
  const snap = await campaignRef.once('value');
  const campaign = snap.val();

  if (!campaign || campaign.cancelled) {
    console.log(`[FOLLOWUP] ${uid}/${task.campaignId} cancelled — skip ${nextType}`);
    return;
  }

  const scheduledAt = Date.now() + FOLLOWUP_DELAY_MS;
  const update = {};
  update[`${nextType}ScheduledAt`] = scheduledAt;
  update[`${nextType}Status`] = 'scheduled';
  await campaignRef.update(update);

  // Schedule the timer
  scheduleTask(uid, `${task.campaignId}_${nextType}`, { campaignId: task.campaignId }, FOLLOWUP_DELAY_MS, () => {
    writeFollowup(uid, task, nextType);
  });

  console.log(`[FOLLOWUP] ${uid}/${task.personName} — ${nextType} scheduled in 3d`);
}

async function writeFollowup(uid, parentTask, followupType) {
  const campaignRef = db().ref(`users/${uid}/campaigns/${parentTask.campaignId}`);
  const snap = await campaignRef.once('value');
  const campaign = snap.val();

  if (!campaign || campaign.cancelled) {
    console.log(`[FOLLOWUP] ${uid}/${parentTask.campaignId} cancelled — not writing ${followupType}`);
    return;
  }

  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();

  const task = {
    action: 'message',
    url: parentTask.url,
    message: '', // Will be filled from campaign config by extension
    degree: '1st',
    followupType,
    campaignId: parentTask.campaignId,
    personName: parentTask.personName || '',
    personTitle: parentTask.personTitle || '',
    status: 'pending',
    attemptCount: 0,
    createdAt: now,
  };

  const taskRef = db().ref(`users/${uid}/tasks/${taskId}`);
  await taskRef.set(task);

  const update = {};
  update[`${followupType}TaskId`] = taskId;
  update[`${followupType}Status`] = 'pending';
  await campaignRef.update(update);

  console.log(`[FOLLOWUP] ${uid}/${parentTask.personName} — ${followupType} written as ${taskId}`);
}

// ── Task failed → retry up to 3 times ────────────────────────────────────

async function handleTaskFailed(uid, taskId, task) {
  const attemptCount = (task.attemptCount || 0) + 1;
  const ref = db().ref(`users/${uid}/tasks/${taskId}`);

  if (attemptCount >= MAX_RETRY_ATTEMPTS) {
    await ref.update({
      attemptCount,
      status: 'failed_permanent',
      failedAt: Date.now(),
    });
    console.log(`[RETRY] ${uid}/${taskId} — exhausted ${MAX_RETRY_ATTEMPTS} attempts, permanent fail`);

    // Cancel follow-ups
    const campaignRef = db().ref(`users/${uid}/campaigns/${task.campaignId}`);
    const snap = await campaignRef.once('value');
    const campaign = snap.val();
    if (campaign) {
      const ft = task.followupType;
      if (ft === 'intro') {
        await campaignRef.update({ f1Status: 'cancelled', f2Status: 'cancelled', cancelled: true });
      } else if (ft === 'f1') {
        await campaignRef.update({ f2Status: 'cancelled' });
      }
    }
    return;
  }

  // Determine retry delay based on error type
  const error = task.result?.error || '';
  let retryDelayMs;
  if (error.includes('limit') || error.includes('cooldown') || error.includes('withdraw')) {
    retryDelayMs = 24 * 60 * 60 * 1000; // 24h for LinkedIn limits
  } else if (error.includes('auth') || error.includes('login')) {
    retryDelayMs = 5 * 60 * 1000; // 5min for auth issues
  } else {
    retryDelayMs = 5 * 60 * 1000; // 5min for transient
  }

  const retryAt = Date.now() + retryDelayMs;
  await ref.update({
    attemptCount,
    status: 'retry_scheduled',
    retryAt,
  });

  scheduleTask(uid, taskId, task, retryDelayMs, async () => {
    await ref.update({ status: 'pending' });
    console.log(`[RETRY] ${uid}/${taskId} — attempt ${attemptCount + 1}/${MAX_RETRY_ATTEMPTS} re-queued`);
  });

  console.log(`[RETRY] ${uid}/${taskId} — failed, retry in ${retryDelayMs / 1000}s`);
}

// ── Timer management ─────────────────────────────────────────────────────

function scheduleTask(uid, taskId, _task, delayMs, callback) {
  cancelTaskTimer(uid, taskId);

  const timeout = setTimeout(() => {
    cleanupTimer(uid, taskId);
    callback();
  }, delayMs);

  if (!activeTimers.has(uid)) activeTimers.set(uid, new Map());
  activeTimers.get(uid).set(taskId, timeout);
}

function cancelTaskTimer(uid, taskId) {
  const userTimers = activeTimers.get(uid);
  if (!userTimers) return;
  const handle = userTimers.get(taskId);
  if (handle) {
    clearTimeout(handle);
    userTimers.delete(taskId);
  }
}

function cleanupTimer(uid, taskId) {
  const userTimers = activeTimers.get(uid);
  if (!userTimers) return;
  userTimers.delete(taskId);
  if (userTimers.size === 0) activeTimers.delete(uid);
}

// ── Recover timers on restart ────────────────────────────────────────────

async function recoverTimers(uid) {
  const campaignRef = db().ref(`users/${uid}/campaigns`);
  const snap = await campaignRef.once('value');
  if (!snap.val()) return;

  snap.forEach((child) => {
    const campaign = child.val();
    if (!campaign || campaign.cancelled) return;

    const now = Date.now();

    // Recover scheduled F1
    if (campaign.f1ScheduledAt && campaign.f1Status === 'scheduled') {
      const remaining = campaign.f1ScheduledAt - now;
      if (remaining > 0) {
        scheduleTask(uid, `${child.key}_f1`, { campaignId: child.key }, remaining, () => {
          writeFollowup(uid, campaign.introTaskId ? { url: campaign.url, campaignId: child.key, personName: campaign.name } : { campaignId: child.key }, 'f1');
        });
        console.log(`[RECOVER] ${uid}/${child.key} — F1 timer recovered (${Math.round(remaining / 3600000)}h remaining)`);
      } else if (campaign.f1Status !== 'pending') {
        // Should have fired already, fire now
        writeFollowup(uid, { url: campaign.url, campaignId: child.key, personName: campaign.name }, 'f1');
      }
    }

    // Recover scheduled F2
    if (campaign.f2ScheduledAt && campaign.f2Status === 'scheduled') {
      const remaining = campaign.f2ScheduledAt - now;
      if (remaining > 0) {
        scheduleTask(uid, `${child.key}_f2`, { campaignId: child.key }, remaining, () => {
          writeFollowup(uid, { campaignId: child.key }, 'f2');
        });
        console.log(`[RECOVER] ${uid}/${child.key} — F2 timer recovered (${Math.round(remaining / 3600000)}h remaining)`);
      } else if (campaign.f2Status !== 'pending') {
        writeFollowup(uid, { campaignId: child.key }, 'f2');
      }
    }
  });
}

// ── Cleanup timers on shutdown ──────────────────────────────────────────

process.on('SIGTERM', () => {
  console.log('[SERVER] Shutting down, clearing timers...');
  for (const [, userTimers] of activeTimers) {
    for (const [, handle] of userTimers) clearTimeout(handle);
  }
  activeTimers.clear();
  process.exit(0);
});
