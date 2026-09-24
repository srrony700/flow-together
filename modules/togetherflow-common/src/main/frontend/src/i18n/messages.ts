/**
 * Message catalogue for everything `togetherflow-common` renders — the shared shell,
 * the screen states, the form renderer and the API client's own error copy.
 *
 * `en` is the source of truth. A translation is a sibling file exporting the same keys;
 * the provider merges whatever locales it is handed, so adding one is additive and needs
 * no change here.
 *
 * Keys are dotted and grouped by the component that owns them. Plural forms use the
 * `.one` / `.other` suffixes `Intl.PluralRules` selects between.
 */

import type { Catalogues, Messages } from "./I18nContext";

export const commonEn = {
  // Formatting fallbacks
  "format.none": "—",
  "format.noDueDate": "No due date",
  "format.priority.high": "High",
  "format.priority.normal": "Normal",
  "format.priority.low": "Low",

  // Screen states (§14.1)
  "states.loading": "Loading",
  "states.noResults.title": "No matches",
  "states.noResults.description": "No items match the filters you've applied.",
  "states.noResults.clear": "Clear filters",
  "states.permissionDenied.title": "You don't have access to this",
  "states.permissionDenied.description":
    "Your account doesn't have the privilege needed to view this. Ask an administrator if you think this is wrong.",
  "states.error.title": "Couldn't load this",
  "states.error.fallback": "Something went wrong.",
  "states.error.reference": "Reference:",
  "states.error.retry": "Try again",

  // Crash recovery (§13.2)
  "errorBoundary.title": "This screen stopped working",
  "errorBoundary.description":
    "Something went wrong while displaying this page. The problem has been reported. You can try again, or reload if it keeps happening.",
  "errorBoundary.retry": "Try again",
  "errorBoundary.reload": "Reload the page",
  "errorBoundary.reference": "Reference:",

  // Table + paging
  "pagination.label": "Pagination",
  "pagination.status": "{first}–{last} of {total}",
  "pagination.previous": "Previous",
  "pagination.next": "Next",
  "pagination.first": "First page",
  "pagination.last": "Last page",
  "pagination.page": "Page {page} of {pageCount}",
  "pagination.perPage": "Per page",

  // Confirmation dialog (§14.3)
  "dialog.confirm": "Confirm",
  "dialog.cancel": "Cancel",
  "dialog.close": "Close",

  // Data table (C1)
  "table.select.all": "Select every row on this page",
  "table.select.row": "Select this row",
  "table.bulk.label": "Bulk actions",
  "table.bulk.selected.one": "{count} selected",
  "table.bulk.selected.other": "{count} selected",
  "table.bulk.clear": "Clear selection",
  "table.columns.label": "Columns",
  "table.columns.required": "This column can't be hidden.",
  "table.density.comfortable": "Comfortable",
  "table.density.compact": "Compact",
  "table.rowActions.header": "Row actions",
  "table.rowActions.label": "Actions for this row",

  // Navigation chrome (B1, F2)
  "nav.collapse": "Collapse",
  "nav.expand": "Expand",
  "breadcrumb.label": "Breadcrumb",

  /*
   * Shared action labels. These live here rather than in each app's catalogue because
   * §14.3 asks for consistent UX writing across the product — "Delete" meaning the same
   * thing and reading the same way in all four apps is exactly what four separate
   * catalogues would let drift.
   */
  "action.save": "Save",
  "action.delete": "Delete",
  "action.close": "Close",
  "action.edit": "Edit",
  "action.add": "Add",
  "action.remove": "Remove",
  "action.open": "Open",
  "action.export": "Export",
  "action.import": "Import",
  "action.duplicate": "Duplicate",
  "action.grant": "Grant",
  "action.revoke": "Revoke",
  "action.done": "Done",
  "action.undo": "Undo",
  "action.redo": "Redo",
  "action.fit": "Fit",
  "action.deploy": "Deploy",
  "action.publish": "Publish",
  "action.check": "Check",
  "action.show": "Show",
  "action.dismiss": "Dismiss",
  "action.download": "Download",
  "action.suspend": "Suspend",
  "action.terminate": "Terminate",
  "action.required": "Required",
  "action.moveUp": "Move up",
  "action.moveDown": "Move down",

  // Toasts (§14.3)
  "toast.reference": "Reference:",
  "toast.dismiss": "Dismiss notification",

  // Shell: account menu, app switcher, theme (§7.5)
  "shell.skipToContent": "Skip to main content",
  "shell.tenant.label": "Active tenant",
  "shell.menu.accountFor": "Account menu for {userId}",
  "shell.menu.signedInAs": "Signed in as",
  "shell.menu.tenant": "Tenant: {tenantId}",
  "shell.menu.otherApps": "Other apps",
  "shell.menu.appName": "TogetherFlow {app}",
  "shell.menu.appearance": "Appearance",
  "shell.menu.language": "Language",
  "shell.menu.theme.system": "Match system",
  "shell.menu.theme.light": "Light",
  "shell.menu.theme.dark": "Dark",
  "shell.menu.changePassword": "Change password",
  "shell.menu.signOut": "Sign out",
  "shell.app.work": "Work",
  "shell.app.control": "Control",
  "shell.app.identity": "Identity",
  "shell.app.design": "Design",

  // Change password
  "password.title": "Change password",
  "password.description":
    "Sets a new password for {userId}. You'll use it the next time you sign in — this session stays signed in.",
  "password.new": "New password",
  "password.confirm": "Confirm new password",
  "password.tooShort": "Use at least {min} characters.",
  "password.mismatch": "The two passwords don't match.",
  "password.changed": "Password changed.",
  "password.failed": "Could not change your password.",

  // Sign-in (§7.5)
  "login.title": "Sign in",
  "login.subtitle.work": "Access your tasks, cases and work items.",
  "login.subtitle.control": "Monitor and operate the engines.",
  "login.subtitle.identity": "Manage users, groups and privileges.",
  "login.subtitle.design": "Author and deploy models.",
  "login.missingCredentials": "Enter both your username and password.",
  "login.failed": "Could not sign in. Please try again.",
  "login.sso.note": "You'll be redirected to your organisation's sign-in page.",
  "login.sso.redirecting": "Redirecting…",
  "login.sso.submit": "Continue to sign in",
  "login.username": "Username",
  "login.password": "Password",
  "login.signingIn": "Signing in…",
  "login.submit": "Sign in",
  "login.devNote": "Development sign-in. Production deployments use single sign-on.",

  // API client error copy (§14.1: specific and actionable, never a bare failure)
  "api.error.offline": "Could not reach the server. Check your connection and try again.",
  // Raised before any request leaves the browser, when nobody is signed in yet. Users
  // should never see it — a screen that asks for data while signed out is the bug.
  "api.error.unauthenticated": "You need to sign in before this can load.",
  "api.error.timeout": "The server took too long to respond. Try again.",
  "api.error.400": "The server rejected that request as invalid.",
  "api.error.401": "Your session has expired. Sign in again to continue.",
  "api.error.403": "You do not have permission to do that.",
  "api.error.404": "That item no longer exists. It may have been completed or deleted.",
  "api.error.409": "Someone else changed this item first. Refresh and try again.",
  "api.error.unexpected": "The server returned an unexpected error ({status}).",

  // Keyboard shortcuts (§14.4)
  "shortcuts.title": "Keyboard shortcuts",
  "shortcuts.help": "Show keyboard shortcuts",

  // Saved filters (§14.4)
  "savedViews.apply": "Apply a saved view",
  "savedViews.placeholder": "Saved views…",
  "savedViews.save": "Save this view",
  "savedViews.confirmSave": "Save",
  "savedViews.delete": "Delete view",
  "savedViews.nameLabel": "Name for this view",
  "savedViews.namePlaceholder": "e.g. Overdue, high priority",
  "savedViews.note": "Saved views are kept in this browser only.",

  // Workspaces (ADR 0017)
  "workspace.label": "Active workspace",
  "workspace.unavailable": "Workspaces unavailable",
  "workspace.unavailable.hint":
    "This deployment is configured to use workspaces, but the workspace service didn't answer. Model permissions can't be checked until it does.",

  // Form renderer (§7.1 / ADR 0007)
  "form.choose": "Choose…",
  "form.userId": "User id",
  "form.groupId": "Group id",
  "form.upload.failed": "Upload failed.",
  "form.upload.busy": "Uploading…",
  "form.upload.beforeStart":
    "Files can't be attached before the work is started — start it first, then attach from the task.",
  "form.upload.attached": "Attached {name}",
  "form.upload.download": "Download {name}",
  "form.required": "This field is required.",
  "form.requiredHint": "required",
  "form.optional": "optional",
  "form.notAnswered": "Not answered",
  "form.yes": "Yes",
  "form.no": "No",
  "form.charactersLeft.one": "{count} character left",
  "form.charactersLeft.other": "{count} characters left",
  "form.charactersOver.one": "{count} character too many",
  "form.charactersOver.other": "{count} characters too many",

  // Upload field (§7.1, §7.6)
  "form.upload.prompt": "Choose a file or drag it here",
  "form.upload.replacePrompt": "Choose a different file or drag it here",
  "form.upload.accepts": "Accepts {accept}",
  "form.upload.maxSize": "Up to {size}",
  "form.upload.remove": "Remove {name}",
  "form.upload.tooLarge": "That file is {size}, which is over the {limit} limit.",
  "form.upload.wrongType": "That file type isn't accepted here. Accepts {accept}.",

  // Validation (§14.3 — inline, as the user types or tabs)
  "form.validation.required": "{field} is required.",
  "form.validation.integer": "Enter a whole number.",
  "form.validation.number": "Enter a number.",
  "form.validation.date": "Enter a valid date.",
  "form.validation.minLength": "Enter at least {min} characters.",
  "form.validation.maxLength": "Use {max} characters or fewer.",
  "form.validation.min": "Enter {min} or more.",
  "form.validation.max": "Enter {max} or less.",
  "form.validation.pattern": "Enter this in the format the form expects.",
  "form.validation.minDate": "Enter {date} or later.",
  "form.validation.maxDate": "Enter {date} or earlier.",
  "form.validation.type": "That value is not the kind this field takes.",
  "form.validation.option": "Choose one of the listed options.",
  "form.validation.user": "Choose a known user.",
  "form.validation.group": "Choose a known group.",
  "form.validation.upload": "That file does not belong to this task.",
  "form.validation.outcome": "That outcome is not one this form offers.",
  // The engine refused the submission on rules of its own (FR-S.7)
  "form.server.rejected": "The server refused this submission — check the fields marked below.",

  // People and group pickers (FR-W.5)
  "form.identity.searching": "Searching…",
  "form.identity.noMatch": "No match for \"{query}\" — the id will be sent as typed.",
  "form.identity.userHint": "Start typing a name or user id.",
  "form.identity.groupHint": "Start typing a group name or id.",

  // Error summary shown after a submit attempt (§14.1)
  "form.errors.title.one": "There is 1 problem with this form",
  "form.errors.title.other": "There are {count} problems with this form",
} satisfies Messages;

export const commonMessages: Catalogues = { en: commonEn };

/** Key set of the source catalogue, so a translation can be checked against it in a test. */
export type CommonMessageKey = keyof typeof commonEn;
