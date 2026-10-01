import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

/** Sortable, prefixed ids such as lic_01J9Z… (monotonic, so creation order is id order); licenseIds must match the app's /^[A-Za-z0-9._-]{1,64}$/. */
export const newId = (prefix: 'usr' | 'team' | 'mem' | 'inv' | 'lic' | 'evt') => `${prefix}_${ulid()}`;
