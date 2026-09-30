/**
 * The prompt path the Backend's restart-resume uses.
 *
 * Resuming an orphaned task means prompting a session, which only the attached runtime can do. The
 * runtime is resolved at call time on purpose: the startup sequence attaches it before the
 * reconciliation that offers orphaned tasks to the resume service. A missing runtime is refused
 * instead of reported as a successful resume.
 */
export function createResumePrompt({ getRuntime }) {
  if (typeof getRuntime !== "function") throw new Error("getRuntime is required");
  // Async on purpose: the caller awaits it, and a missing runtime is a rejection like any other
  // failed prompt, not a synchronous throw in the middle of the resume service.
  return async function resumePrompt(taskId, prompt) {
    const runtime = getRuntime();
    if (typeof runtime?.promptTask !== "function") {
      throw Object.assign(new Error("runtime unavailable"), { status: 503 });
    }
    // `resume` keeps the interrupted turn's model/account handling, like the WebUI's own resume.
    return runtime.promptTask(taskId, prompt, undefined, { resume: true });
  };
}
