/**
 * An error whose message is written for the user and safe to show in the UI.
 * Anything else reaching the IPC boundary is reported as an internal error.
 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}
