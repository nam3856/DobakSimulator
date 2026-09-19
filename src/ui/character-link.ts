import type { AppTab } from './constants';

export function buildCharacterShareLink(name: string, mode: AppTab, apiBase?: string): string {
  const url = new URL('/share', apiBase ?? 'https://dobak-character-api.isekai-jikjak.workers.dev');
  url.searchParams.set('character', name.trim());
  url.searchParams.set('mode', mode);
  return url.href;
}

export function getLinkedCharacter(): string {
  return new URL(location.href).searchParams.get('character')?.trim() ?? '';
}

export function replaceCharacterLink(name: string, mode: AppTab) {
  const url = new URL(location.href);
  url.searchParams.set('character', name);
  url.hash = mode;
  history.replaceState(history.state, '', url);
}
