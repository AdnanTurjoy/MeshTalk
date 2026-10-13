import type { Migration } from '../migrator';
import { migration0001 } from './0001_settings';
import { migration0002 } from './0002_identity_contacts';
import { migration0003 } from './0003_messaging';
import { migration0004 } from './0004_files';
import { migration0005 } from './0005_calls';
import { migration0006 } from './0006_groups';
import { migration0007 } from './0007_skills';
import { migration0008 } from './0008_app_lock';

/** Append-only. Never edit a migration that has shipped; add a new one. */
export const migrations: readonly Migration[] = [
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
  migration0006,
  migration0007,
  migration0008,
];
