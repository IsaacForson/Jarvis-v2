// Shared by everything that presses buttons for the user, on web pages and in Mac apps.

/** Jarvis never spends money, whoever asks. A control with a label like this is refused outright, not asked about. */
export const PAYMENT = /\b(pay( now)?|buy( now| it now)?|purchase|place (your |my )?order|check ?out|complete (order|purchase)|donate|send money|transfer|subscribe (now|and pay))\b/i;

/** Deleting is always asked about, even when Jarvis works on its own. Matched against the question and the raw arguments. */
export const DELETION = /\b(delete|deleting|remove|erase|trash|rm|rmdir|unlink|empty|wipe|destroy|drop|shred|truncate|uninstall|forget)\b/i;

/** Controls that change something for real. These are asked about first. */
export const RISKY = /\b(delete|remove|erase|empty|send|post|publish|confirm|submit|sign ?up|register|subscribe|unsubscribe|accept|agree|cancel|book|reserve|apply|save|update|upload|install|uninstall|log ?out|sign ?out|shut ?down|restart|format|reset)\b/i;
