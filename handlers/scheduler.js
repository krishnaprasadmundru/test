import { db } from '../firebase.js';

const MAX_RETRY_ATTEMPTS = 3;
const ACK_TIMEOUT_MS = 120_000; // 2 min (was 60s — give extension more time)

// Helper to compute personKey derived from URL and task creation timestamp
function getPersonKey(url, createdAt) {
  if (!url) return '';
  const cleanUrl = url.split('?')[0].replace(/\/$/, '').replace(/^https?:\/\/(www\.)?/, '');
  return encodeURIComponent(cleanUrl)
    .replace(/%2F/g, '_')
    .replace(/\./g, '_')
    .replace(/-/g, '_')
    .replace(/%/g, '_')
    .substring(0, 100)
    + `_${createdAt}`;
}

// ── Start watching RTDB ──────────────────────────────────────────────────

export function startScheduler() {
  const rootRef = db().ref('users');
  const watchedUsers = new Set();

  rootRef.on('child_added', (snap) => {
    const uid = snap.key;
    if (watchedUsers.has(uid)) return;
    watchedUsers.add(uid);
    watchUserTasks(uid);
  });

  // Also check existing users on startup
  rootRef.once('value', (snap) => {
    if (!snap.val()) return;
    snap.forEach((child) => {
      const uid = child.key;
      if (watchedUsers.has(uid)) return;
      watchedUsers.add(uid);
      watchUserTasks(uid);
    });
  });

  console.log('[SCHEDULER] Passive scheduler running: Server coordinates sequence and triggers.');
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
}

// ── Handle task status changes ──────────────────────────────────────────

async function handleTaskStatus(uid, taskId, task) {
  if (task.cancelled || task.status === 'cancelled') return;

  switch (task.status) {
    case 'pending': {
      console.log(`[SCHEDULER] Task pending (inspected): ${uid}/${taskId} (${task.followupType || 'intro'})`);
      break;
    }

    case 'processing': {
      console.log(`[SCHEDULER] Task processing (inspected): ${uid}/${taskId} (${task.followupType || 'intro'})`);

      // ── Stuck-task recovery ──
      // If extension tab was closed mid-send, task stays "processing" forever.
      // Server sets a timer: if still "processing" after ACK_TIMEOUT_MS,
      // reset it to "failed" so retry/cascade logic kicks in.
      const processingStartedAt = task.updatedAt || task.processingAt || Date.now();
      const elapsed = Date.now() - processingStartedAt;

      if (elapsed >= ACK_TIMEOUT_MS) {
        // Already past timeout — reset immediately
        console.log(`[STUCK-RECOVERY] ${uid}/${taskId} stuck in processing for ${Math.round(elapsed / 1000)}s — resetting to failed now`);
        await db().ref(`users/${uid}/tasks/${taskId}`).update({
          status: 'failed',
          error: 'stuck_processing_timeout',
          failedAt: Date.now(),
          updatedAt: Date.now(),
        });
      } else {
        // Set a delayed check
        const remainingMs = ACK_TIMEOUT_MS - elapsed;
        console.log(`[STUCK-RECOVERY] ${uid}/${taskId} — will check again in ${Math.round(remainingMs / 1000)}s`);
        setTimeout(async () => {
          try {
            const snap = await db().ref(`users/${uid}/tasks/${taskId}`).once('value');
            const current = snap.val();
            if (current && current.status === 'processing') {
              console.log(`[STUCK-RECOVERY] ${uid}/${taskId} STILL stuck after ${ACK_TIMEOUT_MS / 1000}s — resetting to failed`);
              await db().ref(`users/${uid}/tasks/${taskId}`).update({
                status: 'failed',
                error: 'stuck_processing_timeout',
                failedAt: Date.now(),
                updatedAt: Date.now(),
              });
            }
          } catch (e) {
            console.warn(`[STUCK-RECOVERY] Timer check failed:`, e.message);
          }
        }, remainingMs);
      }
      break;
    }

    case 'completed': {
      console.log(`[SCHEDULER] Task completed: ${uid}/${taskId} (${task.followupType || 'intro'})`);
      
      const pk = task.pk || getPersonKey(task.url, task.createdAt);
      if (!pk) return;

      const ft = task.followupType || 'intro';
      const isIntro = ft === 'intro' || ft === 'cr';

      // Define schema fields
      const field = ft === 'intro' ? 'intro' : ft === 'cr' ? 'cr' : ft === 'f1' ? 'f1' : ft === 'f2' ? 'f2' : ft === 'inmail' ? 'im' : null;
      const stField = ft === 'intro' || ft === 'cr' ? 'i_st' : ft === 'f1' ? 'f1_st' : ft === 'f2' ? 'f2_st' : ft === 'inmail' ? 'im_st' : null;
      const atField = ft === 'intro' || ft === 'cr' ? 'i_at' : ft === 'f1' ? 'f1_at' : ft === 'f2' ? 'f2_at' : ft === 'inmail' ? 'im_at' : null;

      // ── 1. Update trigger_progress ──
      const progressPatch = {};
      if (field) progressPatch[`trigger_progress/${pk}/${field}`] = 1;
      if (stField) progressPatch[`trigger_progress/${pk}/${stField}`] = 'sent';
      if (atField) progressPatch[`trigger_progress/${pk}/${atField}`] = Date.now();
      progressPatch[`trigger_progress/${pk}/at`] = Date.now();

      await db().ref(`users/${uid}`).update(progressPatch);

      // ── Double-check and delete corresponding trigger in RTDB ──
      try {
        await db().ref(`users/${uid}/trigger/${taskId}`).remove();
        console.log(`[SCHEDULER] Double-checked and removed trigger for completed task: ${uid}/${taskId}`);
      } catch (e) {
        console.warn(`[SCHEDULER] Failed to delete trigger for completed task:`, e.message);
      }

      // Follow-up generation (F1 & F2) and activation is coordinated on the extension side.
      // The server scheduler acts as an inspector, monitoring status changes and archiving history.

      // ── 5. Compile Telemetry & Sequence Completion ──
      const isTerminal = (st) => !st || st === 'sent' || st === 'failed' || st === 'na' || st === 'completed';
      const progressRef = db().ref(`users/${uid}/trigger_progress/${pk}`);
      const progSnap = await progressRef.once('value');
      const prog = progSnap.val() || {};

      const i_st = ft === 'intro' || ft === 'cr' ? 'sent' : (prog.i_st || prog.cr_st || 'na');
      const f1_st = ft === 'f1' ? 'sent' : (prog.f1_st || 'na');
      const f2_st = ft === 'f2' ? 'sent' : (prog.f2_st || 'na');
      const im_st = ft === 'inmail' ? 'sent' : (prog.im_st || 'na');

      const allTerminal = isTerminal(i_st) && isTerminal(f1_st) && isTerminal(f2_st) && isTerminal(im_st);
      const isFinalComplete = allTerminal && (prog.f1 !== 0) && (prog.f2 !== 0);

      if (isFinalComplete) {
        console.log(`[SCHEDULER] Sequence fully complete for ${pk} — archiving history.`);
        const historyKey = `${pk}_${Date.now()}`;
        
        let wasAccepted = false;
        if (prog.accepted || String(task.degree).toLowerCase().includes('1st')) {
          wasAccepted = true;
        }

        await db().ref(`users/${uid}/trigger_history/${historyKey}`).set({
          pk,
          n: prog.n || task.personName || 'Unknown',
          cn: prog.cn || task.campaignName || '',
          d: prog.d || task.degree || '',
          at: Date.now(),
          intro_at: ft === 'intro' || ft === 'cr' ? Date.now() : (prog.i_at || null),
          cr_at: ft === 'intro' || ft === 'cr' ? Date.now() : (prog.cr_at || null),
          f1_at: ft === 'f1' ? Date.now() : (prog.f1_at || null),
          f2_at: ft === 'f2' ? Date.now() : (prog.f2_at || null),
          im_at: ft === 'inmail' ? Date.now() : (prog.im_at || null),
          accepted: wasAccepted,
        });

        // Delete all triggers and tasks in the sequence matching the pk
        try {
          const triggersSnap = await db().ref(`users/${uid}/trigger`).once('value');
          const allTriggers = triggersSnap.val() || {};
          const deleteTriggerPromises = [];
          for (const [key, t] of Object.entries(allTriggers)) {
            if (t && t.pk === pk) {
              deleteTriggerPromises.push(db().ref(`users/${uid}/trigger/${key}`).remove().catch(() => {}));
            }
          }
          await Promise.all(deleteTriggerPromises);
        } catch (e) {
          console.warn(`[SCHEDULER] Trigger batch cleanup failed:`, e.message);
        }

        try {
          const tasksSnap = await db().ref(`users/${uid}/tasks`).once('value');
          const allTasks = tasksSnap.val() || {};
          const deleteTaskPromises = [];
          for (const [key, t] of Object.entries(allTasks)) {
            if (t && t.pk === pk) {
              deleteTaskPromises.push(db().ref(`users/${uid}/tasks/${key}`).remove().catch(() => {}));
            }
          }
          await Promise.all(deleteTaskPromises);
        } catch (e) {
          console.warn(`[SCHEDULER] Tasks batch cleanup failed:`, e.message);
        }

        // Clean current task just in case it doesn't have pk field
        await db().ref(`users/${uid}/trigger/${taskId}`).remove().catch(() => {});
        await db().ref(`users/${uid}/tasks/${taskId}`).remove().catch(() => {});

        await progressRef.remove();
        console.log(`[SCHEDULER] Cleared sequence tasks, triggers, and progress for ${pk}`);
      }
      break;
    }

    case 'failed': {
      const attemptCount = (task.attemptCount || 0) + 1;
      const ref = db().ref(`users/${uid}/tasks/${taskId}`);
      
      if (attemptCount >= MAX_RETRY_ATTEMPTS) {
        await ref.update({
          attemptCount,
          status: 'failed_permanent',
          failedAt: Date.now(),
        });
        console.log(`[RETRY] ${uid}/${taskId} — exhausted attempts, marking failed_permanent`);
        
        // Propagate failure trigger
        await handleTaskStatus(uid, taskId, { ...task, status: 'failed_permanent', attemptCount });
      } else {
        await ref.update({ attemptCount });
        console.log(`[RETRY] ${uid}/${taskId} — attempt ${attemptCount}/${MAX_RETRY_ATTEMPTS} logged`);
        
        // Auto-mirror retry queued status back to corresponding trigger
        const triggerPatch = { st: 'queued', updatedAt: Date.now() };
        if (task.retryAt) {
          triggerPatch.sAt = task.retryAt;
          triggerPatch.scheduledAt = task.retryAt;
        }
        await db().ref(`users/${uid}/trigger/${taskId}`).update(triggerPatch).catch(() => {});

        // Also update progress card step status back to 'queued' so it doesn't show 'Sending' while waiting to retry!
        const pk = task.pk || getPersonKey(task.url, task.createdAt);
        if (pk) {
          const ft = task.followupType || 'intro';
          const stField = ft === 'intro' || ft === 'cr' ? 'i_st' : ft === 'f1' ? 'f1_st' : ft === 'f2' ? 'f2_st' : ft === 'inmail' ? 'im_st' : null;
          if (stField) {
            const progressPatch = {};
            progressPatch[`trigger_progress/${pk}/${stField}`] = 'queued';
            if (task.retryAt) {
              const sAtField = ft === 'intro' || ft === 'cr' ? 'i_sAt' : ft === 'f1' ? 'f1_sAt' : ft === 'f2' ? 'f2_sAt' : ft === 'inmail' ? 'im_sAt' : null;
              if (sAtField) progressPatch[`trigger_progress/${pk}/${sAtField}`] = task.retryAt;
            }
            await db().ref(`users/${uid}`).update(progressPatch).catch(() => {});
          }
        }
      }
      break;
    }

    case 'failed_permanent': {
      console.log(`[SCHEDULER] Task failed permanently: ${uid}/${taskId}`);
      const pk = task.pk || getPersonKey(task.url, task.createdAt);
      if (!pk) return;

      const ft = task.followupType || 'intro';
      const isIntro = ft === 'intro' || ft === 'cr';

      const field = ft === 'intro' ? 'intro' : ft === 'cr' ? 'cr' : ft === 'f1' ? 'f1' : ft === 'f2' ? 'f2' : ft === 'inmail' ? 'im' : null;
      const stField = ft === 'intro' || ft === 'cr' ? 'i_st' : ft === 'f1' ? 'f1_st' : ft === 'f2' ? 'f2_st' : ft === 'inmail' ? 'im_st' : null;

      // Update trigger_progress to failed status
      const failedPatch = {};
      if (field) failedPatch[`trigger_progress/${pk}/${field}`] = -2;
      if (stField) failedPatch[`trigger_progress/${pk}/${stField}`] = 'failed';
      await db().ref(`users/${uid}`).update(failedPatch);

      // ── Double-check and delete corresponding trigger in RTDB ──
      try {
        await db().ref(`users/${uid}/trigger/${taskId}`).remove();
        console.log(`[SCHEDULER] Double-checked and removed trigger for failed_permanent task: ${uid}/${taskId}`);
      } catch (e) {
        console.warn(`[SCHEDULER] Failed to delete trigger for failed_permanent task:`, e.message);
      }

      // ── Cascade Cancel F1/F2 on Intro failure (for all degrees) ──
      if (isIntro) {
        console.log(`[CASCADE-CANCEL] Cancelling followups since initial task failed for ${task.url}`);
        const tasksSnap = await db().ref(`users/${uid}/tasks`).once('value');
        const allTasks = tasksSnap.val() || {};

        for (const [key, t] of Object.entries(allTasks)) {
          if (t.url === task.url && (t.followupType === 'f1' || t.followupType === 'f2') && (t.status === 'waiting' || t.status === 'pending')) {
            // Update task status
            await db().ref(`users/${uid}/tasks/${key}`).update({ status: 'cancelled' });
            // Clean corresponding trigger
            await db().ref(`users/${uid}/trigger/${key}`).remove().catch(() => {});

            // Update progress card
            const depField = t.followupType;
            const depStField = `${t.followupType}_st`;
            const cancelPatch = {};
            cancelPatch[`trigger_progress/${pk}/${depField}`] = -2;
            cancelPatch[`trigger_progress/${pk}/${depStField}`] = 'cancelled';
            await db().ref(`users/${uid}`).update(cancelPatch);
          }
        }
      }
      break;
    }

    case 'accepted': {
      console.log(`[SCHEDULER] Connection accepted: ${uid}/${taskId}`);
      const pk = task.pk || getPersonKey(task.url, task.createdAt);
      if (pk) {
        const patch = {};
        patch[`trigger_progress/${pk}/d`] = '1st';
        patch[`trigger_progress/${pk}/degree`] = '1st';
        patch[`trigger_progress/${pk}/acceptedAt`] = task.acceptedAt || Date.now();
        patch[`trigger_progress/${pk}/accepted`] = true;

        const ft = task.followupType || 'intro';
        if (ft === 'cr' || ft === 'intro') {
          patch[`trigger_progress/${pk}/cr`] = 1;
          patch[`trigger_progress/${pk}/cr_st`] = 'sent';
          patch[`trigger_progress/${pk}/cr_at`] = task.acceptedAt || Date.now();
        }
        await db().ref(`users/${uid}`).update(patch);

        // Find and cascade degree upgrade to F1/F2 tasks and triggers on the server
        try {
          const tasksSnap = await db().ref(`users/${uid}/tasks`).once('value');
          const allTasks = tasksSnap.val() || {};
          const cleanUrl = task.url.split('?')[0].replace(/\/$/, '').replace(/^https?:\/\/(www\.)?/, '');

          for (const [key, t] of Object.entries(allTasks)) {
            const tUrl = (t.url || '').split('?')[0].replace(/\/$/, '').replace(/^https?:\/\/(www\.)?/, '');
            if (tUrl === cleanUrl && (t.followupType === 'f1' || t.followupType === 'f2')) {
              await db().ref(`users/${uid}/tasks/${key}`).update({ degree: '1st' });
              await db().ref(`users/${uid}/trigger/${key}`).update({ d: '1st', degree: '1st' }).catch(() => {});
            }
          }
        } catch (e) {
          console.warn(`[SCHEDULER] Degree cascade failed:`, e.message);
        }
      }
      break;
    }
  }
}

// ── Cleanup timers on shutdown (no-op now, kept for compat) ─────────────

process.on('SIGTERM', () => {
  console.log('[SERVER] Shutting down (passive server scheduler)');
  process.exit(0);
});
