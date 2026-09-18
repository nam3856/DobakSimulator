/// <reference lib="webworker" />
import { createStarforceRunner, type StarforceRunRequest } from '../engine/starforce-runner';

const runner = createStarforceRunner((message) => self.postMessage(message));
self.onmessage = (event: MessageEvent<StarforceRunRequest>) => runner.handle(event.data);
