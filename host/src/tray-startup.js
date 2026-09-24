/**
 * systray2's Windows helper emits "ready" from WM_CREATE before its notify
 * icon state is initialized. Sending the initial menu immediately can panic
 * in getlantern/systray's setIcon. Delay only that first write; all later
 * actions still use systray2 normally.
 */
export function withSafeInitialMenu(SysTray, platform = process.platform) {
  if (platform !== "win32" || typeof SysTray !== "function") return SysTray;

  return class extends SysTray {
    writeLine(line) {
      if (!this.initialMenuWrite) {
        this.initialMenuWrite = new Promise((resolve, reject) => {
          setTimeout(() => {
            try {
              super.writeLine(line);
              resolve();
            } catch (error) {
              reject(error);
            }
          }, 100);
        });
        return this;
      }
      return super.writeLine(line);
    }

    async ready() {
      await super.ready();
      await this.initialMenuWrite;
    }
  };
}
