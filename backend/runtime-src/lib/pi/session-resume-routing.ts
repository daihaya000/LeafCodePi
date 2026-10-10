import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RESUME_HOST_ROUTING_CHANNEL, RESUME_HOST_ROUTING_READY_CHANNEL, type ResumeHostRouting } from "@shared/session-resume";
import { getTask, setTaskStatus } from "@/lib/store";
import { acquireTaskLease, ownsTaskLease, releaseTaskLease } from "@/lib/task-runtime-lease";
import { armTaskHangWatch, disarmTaskHangWatch } from "./hang-watchdog";

const owners = new WeakMap<object, symbol>();
type LiveState = { sessionManager: object; busy: boolean; promptActive: boolean; leaseLost: boolean };

/** Self-resume starts outside queuePrompt, but must still own the host's task lease. */
export function registerSessionResumeTurnRouting(
  taskId: string,
  getLive: () => LiveState | undefined,
  notify: (eventType: string) => void,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.events.emit(RESUME_HOST_ROUTING_CHANNEL, { taskId });
    pi.on("session_start", (_event, ctx) => {
      const manager = ctx.sessionManager;
      const owner = Symbol(taskId);
      owners.set(manager, owner);
      let prepared = false;
      const routing: ResumeHostRouting = {
        sessionManager: manager,
        prepare(prompt) {
          const live = getLive();
          const task = getTask(taskId);
          if (owners.get(manager) !== owner || !live || live.sessionManager !== manager ||
              live.leaseLost || live.busy || !task || task.status === "archived") return false;
          // Another process holding the lease is a retry, never permission to steal it.
          if (!acquireTaskLease(taskId)) return false;
          prepared = true;
          setTaskStatus(taskId, "working");
          armTaskHangWatch({ taskId, prompt, skipResume: true });
          notify("session_resume_prepared");
          return true;
        },
        release() {
          if (!prepared || owners.get(manager) !== owner) return;
          prepared = false;
          const live = getLive();
          if (!live || live.sessionManager !== manager || live.promptActive ||
              getTask(taskId)?.status !== "working" || !ownsTaskLease(taskId)) return;
          disarmTaskHangWatch(taskId);
          setTaskStatus(taskId, "idle");
          releaseTaskLease(taskId);
          notify("session_resume_not_sent");
        },
      };
      pi.events.emit(RESUME_HOST_ROUTING_READY_CHANNEL, routing);
    });
  };
}
