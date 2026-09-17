/// <reference lib="webworker" />
import type { WorkerRequest, WorkerResponse } from '../types';
import { computeBenchmark, loadRuleData, rollBatch } from '../engine';

let loadedBaseUrl = '';
let dataPromise: ReturnType<typeof loadRuleData> | undefined;
function rulesFor(baseUrl?: string) {
  const resolved = baseUrl ?? new URL(import.meta.env.BASE_URL, self.location.origin).href;
  if (!dataPromise || loadedBaseUrl !== resolved) {
    loadedBaseUrl = resolved;
    dataPromise = loadRuleData(resolved).catch((error) => {
      dataPromise = undefined;
      throw error;
    });
  }
  return dataPromise;
}
let activeId = '';
const send = (message: WorkerResponse) => self.postMessage(message);
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === 'stop') {
    if (activeId === request.id) activeId = '';
    return;
  }
  activeId = request.id;
  try {
    const data = await rulesFor(request.baseUrl);
    if (activeId !== request.id) return;
    if (request.type === 'benchmark') {
      const result = computeBenchmark(data, request.config, request.actualCost);
      if (activeId === request.id) send({ type: 'benchmark', id: request.id, result });
      return;
    }
    let state = request.state;
    const starting = state.attempts;
    const limit = BigInt(Math.max(1, Math.floor(request.maxAttempts)));
    while (
      activeId === request.id &&
      state.attempts - starting < limit &&
      state.status !== 'success' &&
      state.status !== 'impossible'
    ) {
      const frameStart = performance.now();
      do {
        state = rollBatch(data, request.config, state);
      } while (
        performance.now() - frameStart < 24 &&
        state.attempts - starting < limit &&
        state.status !== 'success' &&
        state.status !== 'impossible'
      );
      const done =
        state.status === 'success' ||
        state.status === 'impossible' ||
        state.attempts - starting >= limit;
      send({ type: 'state', id: request.id, state, done });
      if (done) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (activeId !== request.id)
      send({
        type: 'state',
        id: request.id,
        state: { ...state, status: state.status === 'success' ? 'success' : 'paused' },
        done: true,
      });
  } catch (error) {
    send({
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
