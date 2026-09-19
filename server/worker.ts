import { handleCharacterRequest, type CharacterApiEnv } from './character-api.ts';
import { handleShareRequest } from './share-page.ts';

export default {
  fetch(request: Request, env: CharacterApiEnv): Promise<Response> {
    if (new URL(request.url).pathname === '/share')
      return Promise.resolve(handleShareRequest(request));
    return handleCharacterRequest(request, env, {
      rateLimitKey: request.headers.get('CF-Connecting-IP') ?? undefined,
    });
  },
};
