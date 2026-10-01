/** The most common throwaway-mail domains; enough to stop casual free-key farming. */
const DISPOSABLE = new Set([
  '10minutemail.com', '20minutemail.com', 'dispostable.com', 'emailondeck.com', 'fakeinbox.com', 'getnada.com',
  'guerrillamail.com', 'guerrillamail.net', 'guerrillamailblock.com', 'maildrop.cc', 'mailinator.com', 'mailnesia.com',
  'mintemail.com', 'mohmal.com', 'sharklasers.com', 'spamgourmet.com', 'temp-mail.org', 'tempmail.com', 'tempmail.net',
  'tempmailo.com', 'throwawaymail.com', 'trashmail.com', 'yopmail.com', 'yopmail.net', 'mailpoof.com', 'tmpmail.org',
  'tmail.ws', 'mail.tm', 'burnermail.io', 'emailfake.com', 'moakt.com', 'spambox.us',
]);

export const isDisposableEmail = (email: string) => DISPOSABLE.has(email.slice(email.lastIndexOf('@') + 1).toLowerCase());
