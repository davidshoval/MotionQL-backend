// Personal mailbox providers. An address at one of these says nothing about the company someone works for, so the
// acquisition report leaves them out when it counts companies by e-mail domain.

/** Exact domains. */
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'ymail.com', 'rocketmail.com',
  'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me',
  'aol.com', 'aim.com',
  'mail.com', 'email.com',
  'qq.com', 'foxmail.com', '163.com', '126.com', 'yeah.net', 'sina.com', 'sohu.com',
  'mail.ru', 'bk.ru', 'inbox.ru', 'list.ru', 'rambler.ru',
  'web.de', 't-online.de', 'freenet.de',
  'naver.com', 'daum.net', 'hanmail.net',
  'tutanota.com', 'tuta.io', 'fastmail.com', 'zohomail.com', 'hey.com',
  'rediffmail.com', 'libero.it', 'orange.fr', 'laposte.net', 'free.fr', 'wanadoo.fr',
]);

/**
 * Providers that run the same service under many country domains: gmx.de, gmx.net, yandex.ru, yahoo.co.uk,
 * hotmail.fr, outlook.de, live.co.uk and so on. The family name must be the whole first label.
 */
const FREE_MAIL_FAMILIES = ['gmx', 'yandex', 'yahoo', 'hotmail', 'outlook', 'live'];

/** The part after the @, lower-cased; empty when there is none. */
export const emailDomain = (email: string) => {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1).trim().toLowerCase();
};

export function isFreeMailDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase();
  if (!d) return false;
  if (FREE_MAIL.has(d)) return true;
  const dot = d.indexOf('.');
  return dot > 0 && FREE_MAIL_FAMILIES.includes(d.slice(0, dot));
}

/** The company domain of an address, or undefined for a personal mailbox. */
export function companyDomain(email: string): string | undefined {
  const d = emailDomain(email);
  return d && !isFreeMailDomain(d) ? d : undefined;
}
