/** Every API error has this body: { error: { code, message, fields? } }. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, fields?: Record<string, string>) => new AppError(400, code, message, fields);
export const unauthorized = (message = 'Sign in to continue.') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do that.') => new AppError(403, 'forbidden', message);
export const notFound = (message = 'Not found.') => new AppError(404, 'not_found', message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
