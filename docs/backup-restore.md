# Backup and restore

Open **Settings → Backup and your data**.

## Back up

1. Choose **Back up…**.
2. Optionally include this device's identity, protected by a passphrase. You
   need this to restore on a **different** computer or user account, because
   the identity key is otherwise locked to this computer's keychain.
3. Pick a folder. MeshTalk writes `MeshTalk-Backup-<date>/` with:
   - `meshtalk.db`: a consistent snapshot of the database, taken while the app runs
   - `files/`: received files and the voice notes and pasted images you sent
   - `identity.json`: only if you set a passphrase (scrypt + AES-256-GCM)
   - `manifest.json`: version, date, device ID, file count

**The backup is not encrypted** (except the identity key). Anyone with the folder
can read your messages and files. Keep it on an encrypted drive. Files you sent
from elsewhere on your disk are not copied; MeshTalk only keeps a reference to
them.

## Restore

1. Choose **Restore…** and pick a backup folder.
2. If the backup came from another computer, enter its passphrase.
3. MeshTalk restarts. Your current data is **moved aside** to
   `pre-restore-<timestamp>/` in the data folder, not deleted.

A backup made by a newer MeshTalk can't be restored into an older one.

## Export my data

Writes readable JSON (profile, contacts, conversations with messages, groups,
calls, skills, bookmarks, settings). Files are not included. Use Backup for a
complete copy.

## Delete all data

Removes your profile, device identity, contacts, messages, files and settings
from this computer after you type DELETE. Copies your contacts already received
stay on their devices.

## Where the data is

| OS      | Folder                                   |
| ------- | ---------------------------------------- |
| macOS   | `~/Library/Application Support/MeshTalk` |
| Windows | `%APPDATA%\MeshTalk`                     |
| Linux   | `~/.config/MeshTalk`                     |

Profiles (`--profile=name`) use `MeshTalk-name` next to the default folder.

## If the database is damaged

MeshTalk shows "The local database appears to be damaged" and does not start.
Move `data/meshtalk.db*` aside (don't delete it), then start MeshTalk fresh or
restore a backup. **Diagnostics → Database health** checks a working database.
