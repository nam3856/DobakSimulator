import type { AppTab } from './constants';

export function getLinkedCharacter(): string {
  return new URL(location.href).searchParams.get('character')?.trim() ?? '';
}

export function replaceCharacterLink(name: string, mode: AppTab) {
  const url = new URL(location.href);
  url.searchParams.set('character', name);
  url.hash = mode;
  history.replaceState(history.state, '', url);
}
