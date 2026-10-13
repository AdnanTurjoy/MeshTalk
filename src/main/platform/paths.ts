import { join } from 'node:path';

export interface AppPaths {
  userData: string;
  database: string;
  files: string;
  logs: string;
}

/** All on-disk locations derive from Electron's per-OS userData directory. */
export function appPaths(userData: string): AppPaths {
  return {
    userData,
    database: join(userData, 'data', 'meshtalk.db'),
    files: join(userData, 'files'),
    logs: join(userData, 'logs'),
  };
}

/** Per-profile userData sits beside the default one, e.g. `MeshTalk-alice`. */
export function profileUserData(appData: string, productName: string, profile: string): string {
  return join(appData, `${productName}-${profile}`);
}
