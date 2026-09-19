/** Keep the invitation natural for Korean names, including the ㄹ exception. */
export function characterShareHeadline(name: string): string {
  const nickname = name.trim();
  const last = nickname.charCodeAt(nickname.length - 1);
  const finalConsonant = last >= 0xac00 && last <= 0xd7a3 ? (last - 0xac00) % 28 : -1;
  const particle = finalConsonant === 0 || finalConsonant === 8 ? '로' : '으로';
  return `이세계의 ${nickname}${particle} 강화하기`;
}
