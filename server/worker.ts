import { handleCharacterRequest, type CharacterApiEnv } from './character-api.ts';

export default {
  fetch(request: Request, env: CharacterApiEnv): Promise<Response> {
    return handleCharacterRequest(request, env, {
      rateLimitKey: request.headers.get('CF-Connecting-IP') ?? undefined,
    });
  },
};
