/**
 * Button labels for the VS Code notification API, defined once.
 *
 * `showInformationMessage(message, ...labels)` returns the label the user
 * clicked, so the caller can only recognize its own button by the same string.
 * That makes the label a protocol value, not copy: duplicating it at the call
 * site and the comparison is how a rename silently disables the action (the
 * comparison stops matching and the button does nothing). Declaring each label
 * once removes that failure mode, and it is where a localized label would be
 * threaded through if the extension ever ships translations.
 */
export const NotificationAction = {
  SHOW_LOGS: "Show Logs",
  MIGRATE_NOW: "Migrate Now",
  OPEN_FILE: "Open File",
} as const;

export type NotificationAction =
  (typeof NotificationAction)[keyof typeof NotificationAction];
