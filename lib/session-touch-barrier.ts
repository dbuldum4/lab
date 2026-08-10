/** Synchronously-current chain for durable-save metadata touches. */
export class SessionTouchBarrier {
  private current: Promise<boolean> = Promise.resolve(true);

  enqueue(touch: () => Promise<void>) {
    this.current = this.current.then(async () => {
      try {
        await touch();
        return true;
      } catch {
        return false;
      }
    });
  }

  wait() {
    return this.current;
  }
}
