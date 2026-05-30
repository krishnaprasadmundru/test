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

  rootRef.on('child_added', (snap) => {
    const uid = snap.key;
    watchUserTasks(uid);
  });

  // Also check existing users on startup
  rootRef.once('value', (snap) => {
    if (!snap.val()) return;
    snap.forEach((child) => {
      const uid = child.key;
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
      console.log(`[SCHEDULER] Task pending: ${uid}/${taskId}`);
      const pk = task.pk || getPersonKey(task.url, task.createdAt);
      if (pk) {
        const ft = task.followupType || 'intro';
        const stField = ft === 'intro' || ft === 'cr' ? 'i_st' : ft === 'f1' ? 'f1_st' : ft === 'f2' ? 'f2_st' : ft === 'inmail' ? 'im_st' : null;
        if (stField) {
          const patch = {};
          patch[`trigger_progress/${pk}/${stField}`] = 'queued';
          if (task.scheduledAt) {
            const sAtField = ft === 'intro' || ft === 'cr' ? 'i_sAt' : ft === 'f1' ? 'f1_sAt' : ft === 'f2' ? 'f2_sAt' : ft === 'inmail' ? 'im_sAt' : null;
            if (sAtField) patch[`trigger_progress/${pk}/${sAtField}`] = task.scheduledAt;
          }
          await db().ref(`users/${uid}`).update(patch);
        }
      }
      // Auto-mirror queued/scheduled status to corresponding trigger
      const triggerPatch = { st: 'queued', updatedAt: Date.now() };
      if (task.scheduledAt) {
        triggerPatch.sAt = task.scheduledAt;
        triggerPatch.scheduledAt = task.scheduledAt;
      }
      await db().ref(`users/${uid}/trigger/${taskId}`).update(triggerPatch).catch(() => {});
      break;
    }

    case 'processing': {
      console.log(`[SCHEDULER] Task processing: ${uid}/${taskId}`);
      const pk = task.pk || getPersonKey(task.url, task.createdAt);
      if (pk) {
        const ft = task.followupType || 'intro';
        const stField = ft === 'intro' || ft === 'cr' ? 'i_st' : ft === 'f1' ? 'f1_st' : ft === 'f2' ? 'f2_st' : ft === 'inmail' ? 'im_st' : null;
        if (stField) {
          const patch = {};
          patch[`trigger_progress/${pk}/${stField}`] = 'processing';
          await db().ref(`users/${uid}`).update(patch);
        }
      }
      // Auto-mirror processing status to corresponding trigger
      await db().ref(`users/${uid}/trigger/${taskId}`).update({ st: 'processing', status: 'processing', updatedAt: Date.now() }).catch(() => {});
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

      // ── 2. Delete completed /trigger/{taskId} trigger ──
      await db().ref(`users/${uid}/trigger/${taskId}`).remove().catch(() => {});
      console.log(`[SCHEDULER] Deleted completed trigger: ${uid}/trigger/${taskId}`);

      // ── 3. Follow-up Generation (F1 & F2) ──
      if (isIntro && (task.hasF1 || task.mf1)) {
        const liveIs1st = String(task.degree || '2nd').toLowerCase().includes('1st');
        const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
        const nowMs = Date.now();

        const baseF = {
          personName: task.personName || '',
          url: task.url,
          degree: liveIs1st ? '1st' : (task.degree || '2nd'),
          campaignId: task.campaignId || '',
          campaignName: task.campaignName || '',
          pk: pk,
          createdAt: nowMs,
        };

        // Create F1
        const f1Id = `auto_f1_${nowMs}_${Math.random().toString(36).slice(2, 7)}`;
        const f1DependsOn = liveIs1st ? 'intro_sent' : 'accepted';
        const f1DelayMs = liveIs1st ? THREE_DAYS : 0;
        const f1ScheduledAt = liveIs1st ? nowMs + THREE_DAYS : null;

        const f1Task = {
          ...baseF,
          action: 'message',
          followupType: 'f1',
          message: task.mf1 || '',
          status: liveIs1st ? 'pending' : 'waiting',
          attemptCount: 0,
          dependsOn: f1DependsOn,
          delayMs: f1DelayMs,
          scheduledAt: f1ScheduledAt,
          pk: pk,
        };

        const f1Trigger = {
          id: f1Id, fId: f1Id, action: 'SCHEDULE_TASK',
          n: baseF.personName, u: baseF.url, d: baseF.degree, cn: baseF.campaignName,
          pk: pk, cId: baseF.campaignId, ft: 'f1', dp: f1DependsOn,
          st: liveIs1st ? 'queued' : 'waiting', dl: f1DelayMs, m: task.mf1 || '',
          at: nowMs, cAt: nowMs, sAt: f1ScheduledAt, pf1: 0,
          pf2: (task.hasF2 || task.mf2) ? 0 : -1
        };

        await db().ref(`users/${uid}/tasks/${f1Id}`).set(f1Task);
        await db().ref(`users/${uid}/trigger/${f1Id}`).set(f1Trigger);

        // Update progress for F1
        const f1Prog = {};
        f1Prog[`trigger_progress/${pk}/f1`] = 0;
        f1Prog[`trigger_progress/${pk}/f1_st`] = liveIs1st ? 'queued' : 'waiting';
        if (f1ScheduledAt) f1Prog[`trigger_progress/${pk}/f1_sAt`] = f1ScheduledAt;
        await db().ref(`users/${uid}`).update(f1Prog);
        console.log(`[SCHEDULER] Spawned F1: dependsOn=${f1DependsOn}, scheduledIn=${liveIs1st ? '3 days' : 'on acceptance'}`);

        // Create F2 if configured
        if (task.hasF2 || task.mf2) {
          const f2Id = `auto_f2_${nowMs}_${Math.random().toString(36).slice(2, 7)}`;
          const f2Task = {
            ...baseF,
            action: 'message',
            followupType: 'f2',
            message: task.mf2 || '',
            status: 'waiting',
            attemptCount: 0,
            dependsOn: 'f1_sent',
            delayMs: THREE_DAYS,
            scheduledAt: null,
            pk: pk,
          };

          const f2Trigger = {
            id: f2Id, fId: f2Id, action: 'SCHEDULE_TASK',
            n: baseF.personName, u: baseF.url, d: baseF.degree, cn: baseF.campaignName,
            pk: pk, cId: baseF.campaignId, ft: 'f2', dp: 'f1_sent',
            st: 'waiting', dl: THREE_DAYS, m: task.mf2 || '',
            at: nowMs, cAt: nowMs, sAt: null, pf1: 0, pf2: 0
          };

          await db().ref(`users/${uid}/tasks/${f2Id}`).set(f2Task);
          await db().ref(`users/${uid}/trigger/${f2Id}`).set(f2Trigger);

          const f2Prog = {};
          f2Prog[`trigger_progress/${pk}/f2`] = 0;
          f2Prog[`trigger_progress/${pk}/f2_st`] = 'waiting';
          await db().ref(`users/${uid}`).update(f2Prog);
          console.log(`[SCHEDULER] Spawned F2 waiting for F1`);
        }
      }

      // ── 4. Activate F2 when F1 completes ──
      if (ft === 'f1') {
        const tasksSnap = await db().ref(`users/${uid}/tasks`).once('value');
        const allTasks = tasksSnap.val() || {};
        let f2TaskId = null;
        let f2Task = null;
        for (const [key, t] of Object.entries(allTasks)) {
          if (t.url === task.url && t.followupType === 'f2' && t.status === 'waiting') {
            f2TaskId = key;
            f2Task = t;
            break;
          }
        }

        if (f2Task && f2TaskId) {
          const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
          const newSched = Date.now() + THREE_DAYS;

          await db().ref(`users/${uid}/tasks/${f2TaskId}`).update({
            status: 'pending',
            scheduledAt: newSched,
          });

          await db().ref(`users/${uid}/trigger/${f2TaskId}`).update({
            st: 'queued',
            sAt: newSched,
            scheduledAt: newSched,
          });

          const f2Prog = {};
          f2Prog[`trigger_progress/${pk}/f2_st`] = 'queued';
          f2Prog[`trigger_progress/${pk}/f2_sAt`] = newSched;
          await db().ref(`users/${uid}`).update(f2Prog);
          console.log(`[SCHEDULER] Activated F2 sequence. Runs in 3 days.`);
        }
      }

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

        // Delete all triggers in the sequence
        const deleteIds = [];
        if (prog.i_id || prog.intro_id) deleteIds.push(prog.i_id || prog.intro_id);
        if (prog.cr_id) deleteIds.push(prog.cr_id);
        if (prog.f1_id) deleteIds.push(prog.f1_id);
        if (prog.f2_id) deleteIds.push(prog.f2_id);
        if (prog.im_id) deleteIds.push(prog.im_id);
        deleteIds.push(taskId);

        await Promise.all(deleteIds.map(id => db().ref(`users/${uid}/trigger/${id}`).remove().catch(() => {})));
        await progressRef.remove();
        console.log(`[SCHEDULER] Cleared sequence and trigger progress for ${pk}`);
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

      // Clean trigger
      await db().ref(`users/${uid}/trigger/${taskId}`).remove().catch(() => {});

      // ── Cascade Cancel F1/F2 on Intro failure ──
      const is1stDegree = String(task.degree || '').toLowerCase().includes('1st');
      if (isIntro && !is1stDegree) {
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
