import { eq } from 'drizzle-orm';
import {
  defaultSettings,
  isSettingKey,
  settingsSchema,
  type SettingUpdate,
  type Settings,
} from '../../shared/settings';
import type { AppDatabase } from '../db/connection';
import { settings as settingsTable } from '../db/schema';
import type { Logger } from '../logger';

export class SettingsService {
  constructor(
    private readonly db: AppDatabase,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns every setting; unknown, unparsable or invalid rows fall back to defaults. */
  getAll(): Settings {
    const result: Settings = { ...defaultSettings };
    for (const row of this.db.select().from(settingsTable).all()) {
      if (!isSettingKey(row.key)) continue;
      const parsed = settingsSchema.shape[row.key].safeParse(safeJsonParse(row.value));
      if (parsed.success) {
        Object.assign(result, { [row.key]: parsed.data });
      } else {
        this.logger.warn('settings.invalid_value', { setting: row.key });
      }
    }
    return result;
  }

  set(update: SettingUpdate): Settings {
    const value = JSON.stringify(settingsSchema.shape[update.key].parse(update.value));
    const updatedAt = this.now();
    this.db
      .insert(settingsTable)
      .values({ key: update.key, value, updatedAt })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt } })
      .run();
    return this.getAll();
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    const row = this.db.select().from(settingsTable).where(eq(settingsTable.key, key)).get();
    if (!row) return defaultSettings[key];
    const parsed = settingsSchema.shape[key].safeParse(safeJsonParse(row.value));
    return parsed.success ? (parsed.data as Settings[K]) : defaultSettings[key];
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
