// Restoration must finish before any owned listener is closed. Failed attempts remain retryable.
export function createShutdown({ restore, closeServices }) {
  let stopping;
  return () => {
    if (!stopping) stopping = Promise.resolve().then(restore).then(closeServices).catch(error => { stopping = null; throw error; });
    return stopping;
  };
}
