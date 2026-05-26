import { db } from '../firebase.js';

const MAX_RETRY_ATTEMPTS = 3;
const ACK_TIMEOUT_MS = 120_000; // 2 min (was 60s — give extension more time)

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

  console.log('[SCHEDULER] Started watching RTDB (passive mode — extension handles followups)');
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
  if (task.cancelled) return;

  switch (task.status) {
    case 'pending': {
      // ⭐ PHASE 1 FIX: Disable server-side ACK timeout rewrite.
      // The extension owns all scheduling now. Server no longer rewrites
      // status:pending to trigger the extension — this caused an infinite
      // 60-second loop. The extension picks up tasks via SSE /trigger
      // directly; /tasks is now a write-only audit log.
      break;
    }

    case 'acknowledged': {
      // Extension picked it up — nothing to do on server side
      break;
    }

    case 'completed': {
      // ⭐ PHASE 1 FIX: Server no longer schedules followups.
      // The extension creates F1/F2 after intro succeeds (background.js:3208).
      // Server followup timers died on Render sleep and created duplicates.
      break;
    }

    case 'failed': {
      // ⭐ PHASE 1 FIX: Server no longer schedules retry timers.
      // Extension has its own Dexie-based retry queue with categories
      // (transient, limit, auth, permanent) and smarter backoff.
      // Server just marks the attempt count for visibility.
      const attemptCount = (task.attemptCount || 0) + 1;
      const ref = db().ref(`users/${uid}/tasks/${taskId}`);
      if (attemptCount >= MAX_RETRY_ATTEMPTS) {
        await ref.update({
          attemptCount,
          status: 'failed_permanent',
          failedAt: Date.now(),
        });
        console.log(`[RETRY] ${uid}/${taskId} — exhausted ${MAX_RETRY_ATTEMPTS} attempts, permanent fail`);
      } else {
        await ref.update({ attemptCount });
        console.log(`[RETRY] ${uid}/${taskId} — attempt ${attemptCount}/${MAX_RETRY_ATTEMPTS} logged (extension handles retry timing)`);
      }
      break;
    }
  }
}

// ── Cleanup timers on shutdown (no-op now, kept for compat) ─────────────

process.on('SIGTERM', () => {
  console.log('[SERVER] Shutting down (no active timers to clear)');
  process.exit(0);
});
