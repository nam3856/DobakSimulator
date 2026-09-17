import type { SimulatorMode } from '../types';

export function getLinkedCharacter(): string {
  return new URL(location.href).searchParams.get('character')?.trim() ?? '';
}

export function replaceCharacterLink(name: string, mode: SimulatorMode) {
  const url = new URL(location.href);
  url.searchParams.set('character', name);
  url.hash = mode;
  history.replaceState(history.state, '', url);
}
