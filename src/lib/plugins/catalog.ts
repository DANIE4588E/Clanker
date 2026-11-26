import type Feather from '@expo/vector-icons/Feather';
import { usePlugins } from '@/store/plugins';
import { PROVIDERS, type ProviderId } from './providers';

/**
 * Plugins connect agents to the user's apps and services. A plugin belongs to a provider (the
 * account it signs in with; several Google plugins share one Google sign-in) and brings tools. The
 * tools marked `write` change things and are offered only while the plugin's "Allow changes" is on.
 */
export type PluginId =
  | 'gmail'
  | 'google-calendar'
  | 'google-drive'
  | 'google-docs'
  | 'google-sheets'
  | 'google-slides'
  | 'google-tasks'
  | 'outlook'
  | 'outlook-calendar'
  | 'onedrive'
  | 'microsoft-todo'
  | 'github'
  | 'notion'
  | 'linear'
  | 'figma'
  | 'todoist'
  | 'asana'
  | 'clickup'
  | 'airtable'
  | 'dropbox'
  | 'spotify'
  | 'weather'
  | 'atlassian'
  | 'miro'
  | 'calendly'
  | 'granola'
  | 'jotform'
  | 'attio'
  | 'make'
  | 'paypal'
  | 'sentry'
  | 'supabase'
  | 'netlify'
  | 'neon'
  | 'huggingface'
  | 'webflow'
  | 'wix'
  | 'context7'
  | 'excalidraw'
  | 'deepwiki';

export type PluginTool = {
  name: string;
  title: string;
  detail: string;
  write?: boolean;
  /** Shown on the tool's row in a chat. */
  icon?: keyof typeof Feather.glyphMap;
};

export type PluginCategory = 'google' | 'microsoft' | 'productivity' | 'business' | 'design' | 'developer' | 'files' | 'lifestyle';

export type PluginDef = {
  id: PluginId;
  provider: ProviderId;
  title: string;
  /** One line for lists. */
  summary: string;
  /** A short paragraph for the plugin's page. */
  description: string;
  category: PluginCategory;
  /** Place in Popular, lowest first. */
  popular?: number;
  /** Listed under New & Noteworthy. */
  isNew?: boolean;
  website: string;
  privacy?: string;
  terms?: string;
  /** OAuth scopes the plugin needs; without them its tools stay off. */
  scopes: string[];
  /** Prompts to try, shown on the plugin's page; they start with @Title. */
  examples: string[];
  /** One line for the system prompt on how to use the tools well. */
  guide: string;
  /** The tools, for plugins that bring their own; MCP plugins get theirs from the server (see pluginTools). */
  tools: PluginTool[];
};

export const CATEGORY_TITLES: Record<PluginCategory, string> = {
  google: 'Google Workspace',
  microsoft: 'Microsoft 365',
  productivity: 'Productivity',
  business: 'Business',
  design: 'Design & web',
  developer: 'Developer tools',
  files: 'Files',
  lifestyle: 'Lifestyle',
};

const G = 'https://www.googleapis.com/auth/';
export const GOOGLE_SCOPES = {
  gmail: `${G}gmail.modify`,
  calendar: `${G}calendar`,
  drive: `${G}drive`,
  /** Files the app makes or is handed: enough to create Docs, Sheets and Slides through Drive. */
  driveFile: `${G}drive.file`,
  docs: `${G}documents`,
  sheets: `${G}spreadsheets`,
  slides: `${G}presentations`,
  tasks: `${G}tasks`,
} as const;

const GOOGLE_LEGAL = { privacy: 'https://policies.google.com/privacy', terms: 'https://policies.google.com/terms' };
const MS_LEGAL = {
  privacy: 'https://privacy.microsoft.com/privacystatement',
  terms: 'https://www.microsoft.com/servicesagreement',
};

export const PLUGINS: PluginDef[] = [
  // ---- Google ----
  {
    id: 'gmail',
    provider: 'google',
    title: 'Gmail',
    summary: 'Read and manage Gmail',
    description:
      'Use Gmail to find and summarize mail, draft and send replies with attachments from the chat, and keep the inbox tidy with labels, archiving and read status.',
    category: 'google',
    popular: 1,
    website: 'https://mail.google.com',
    ...GOOGLE_LEGAL,
    scopes: [GOOGLE_SCOPES.gmail],
    examples: [
      '@Gmail Summarize my unread emails from today and tell me which ones need a reply',
      '@Gmail Draft a polite, firm reply to the latest email about the invoice, with a short list of what we will provide',
      '@Gmail Find every email from my bank this month and list the amounts mentioned',
    ],
    guide:
      'Gmail: gmail_search takes Gmail search syntax (from:, is:unread, newer_than:7d, has:attachment); read whole threads with gmail_read before replying (save_attachments saves files into gmail/). gmail_send drafts by default, threads replies with reply_to and can forward; send only when the user asked to send.',
    tools: [
      { name: 'gmail_search', title: 'Search mail', detail: 'Find messages with Gmail search', icon: 'search' },
      { name: 'gmail_read', title: 'Read mail', detail: 'Messages and threads, with attachments saved to the workspace', icon: 'mail' },
      { name: 'gmail_send', title: 'Write mail', detail: 'Draft, send and reply, with attachments', write: true, icon: 'send' },
      { name: 'gmail_modify', title: 'Organise mail', detail: 'Labels, archive, read status and trash', write: true, icon: 'tag' },
    ],
  },
  {
    id: 'google-calendar',
    provider: 'google',
    title: 'Google Calendar',
    summary: 'See and schedule events',
    description: 'Use Google Calendar to check your schedule, find free time, and create, move or cancel events, with guests and video calls.',
    category: 'google',
    popular: 3,
    website: 'https://calendar.google.com',
    ...GOOGLE_LEGAL,
    scopes: [GOOGLE_SCOPES.calendar],
    examples: [
      '@Google Calendar What does my week look like? Point out any clashes',
      '@Google Calendar Find a free hour on Thursday afternoon and book "Planning" with a Meet link',
      '@Google Calendar Move my dentist appointment to next Monday at the same time',
    ],
    guide:
      'Google Calendar: times are in the user’s time zone unless they say otherwise; look up an event with calendar_events before changing it. Invitations and updates are emailed to guests by default (send_updates: "none" stops that), and deleting an event can’t be undone.',
    tools: [
      { name: 'calendar_events', title: 'See events', detail: 'Events and calendars in a time range, with free/busy', icon: 'calendar' },
      { name: 'calendar_create_event', title: 'Create events', detail: 'With guests, reminders and Meet links', write: true, icon: 'plus-square' },
      { name: 'calendar_update_event', title: 'Change events', detail: 'Move, edit, reply to or cancel events', write: true, icon: 'edit-3' },
    ],
  },
  {
    id: 'google-drive',
    provider: 'google',
    title: 'Google Drive',
    summary: 'Drive, Docs, Sheets or Slides files',
    description:
      'Use Google Drive to search your files, bring them into the chat to read or work on, and save what the agent makes back to Drive, converted to Google Docs, Sheets or Slides when you want.',
    category: 'google',
    popular: 2,
    website: 'https://drive.google.com',
    ...GOOGLE_LEGAL,
    scopes: [GOOGLE_SCOPES.drive],
    examples: [
      '@Google Drive Find the latest budget spreadsheet and summarize what changed this month',
      '@Google Drive Upload the report you just made to my Reports folder as a Google Doc',
      '@Google Drive List the files I changed this week',
    ],
    guide:
      'Google Drive: find files with drive_search; drive_download saves a file into the workspace under drive/ (Google files as Office files by default); drive_upload puts a workspace file into Drive, converted to a Google format when asked.',
    tools: [
      { name: 'drive_search', title: 'Search Drive', detail: 'Find files by name, type, folder or contents', icon: 'search' },
      { name: 'drive_download', title: 'Download files', detail: 'Bring files into the workspace, exporting Google files to Office, PDF or Markdown', icon: 'download-cloud' },
      { name: 'drive_upload', title: 'Upload files', detail: 'Save workspace files to Drive, or replace a file’s content', write: true, icon: 'upload-cloud' },
      { name: 'drive_manage', title: 'Organise files', detail: 'Create folders, rename, move, copy and trash', write: true, icon: 'folder' },
    ],
  },
  {
    id: 'google-docs',
    provider: 'google',
    title: 'Google Docs',
    summary: 'Read, write and edit documents',
    description:
      'Use Google Docs to read documents, write new ones with headings, lists and tables, and edit existing documents in place: replacing, inserting and deleting text and setting headings.',
    category: 'google',
    popular: 4,
    website: 'https://docs.google.com',
    ...GOOGLE_LEGAL,
    scopes: [GOOGLE_SCOPES.docs, GOOGLE_SCOPES.driveFile],
    examples: [
      '@Google Docs Turn our chat into a one-page project brief as a new document',
      '@Google Docs Proofread this document and fix the spelling and grammar in place: ',
      '@Google Docs Add a "Next steps" section to the end of my meeting notes doc',
    ],
    guide:
      'Google Docs: read with docs_read before editing with docs_edit and quote the text exactly; make targeted edits in place rather than recreating documents. docs_create takes Markdown.',
    tools: [
      { name: 'docs_read', title: 'Read documents', detail: 'Text, headings, lists and tables', icon: 'file-text' },
      { name: 'docs_create', title: 'Create documents', detail: 'New documents with headings, lists, tables and links', write: true, icon: 'file-plus' },
      { name: 'docs_edit', title: 'Edit documents', detail: 'Replace, insert and delete text, set headings and lists', write: true, icon: 'edit-3' },
    ],
  },
  {
    id: 'google-sheets',
    provider: 'google',
    title: 'Google Sheets',
    summary: 'Read and update spreadsheets',
    description: 'Use Google Sheets to read spreadsheets cell by cell, fill in, append or clear ranges with values and formulas, and create new spreadsheets.',
    category: 'google',
    website: 'https://sheets.google.com',
    ...GOOGLE_LEGAL,
    scopes: [GOOGLE_SCOPES.sheets, GOOGLE_SCOPES.driveFile],
    examples: [
      '@Google Sheets Make a spreadsheet tracking my monthly subscriptions with a total row',
      '@Google Sheets Read my expenses sheet and chart spending by category',
      '@Google Sheets Append today’s workout to my training log',
    ],
    guide: 'Google Sheets: sheets_read shows cells with row numbers and column letters; sheets_write enters values as if typed, so formulas work.',
    tools: [
      { name: 'sheets_read', title: 'Read spreadsheets', detail: 'Values or formulas, with their cell positions', icon: 'grid' },
      { name: 'sheets_write', title: 'Update cells', detail: 'Write, append or clear ranges, and add sheets', write: true, icon: 'edit-3' },
      { name: 'sheets_create', title: 'Create spreadsheets', detail: 'New spreadsheets with their first data', write: true, icon: 'file-plus' },
    ],
  },
  {
    id: 'google-slides',
    provider: 'google',
    title: 'Google Slides',
    summary: 'Read and build presentations',
    description: 'Use Google Slides to read the text and speaker notes of presentations and to build new decks from an outline.',
    category: 'google',
    isNew: true,
    website: 'https://slides.google.com',
    ...GOOGLE_LEGAL,
    scopes: [GOOGLE_SCOPES.slides, GOOGLE_SCOPES.driveFile],
    examples: [
      '@Google Slides Make a 6-slide deck introducing our new product, with speaker notes',
      '@Google Slides Summarize this presentation slide by slide: ',
      '@Google Slides Turn my meeting notes into a short status update deck',
    ],
    guide: 'Google Slides: slides_read returns each slide’s text and notes; slides_create builds a deck from titles, bullet points and notes.',
    tools: [
      { name: 'slides_read', title: 'Read presentations', detail: 'Slide text and speaker notes', icon: 'monitor' },
      { name: 'slides_create', title: 'Create presentations', detail: 'Decks from an outline, with notes', write: true, icon: 'file-plus' },
    ],
  },
  {
    id: 'google-tasks',
    provider: 'google',
    title: 'Google Tasks',
    summary: 'Keep track of to-dos',
    description: 'Use Google Tasks to see your to-do lists and add, update and tick off tasks with due dates.',
    category: 'google',
    website: 'https://tasks.google.com',
    ...GOOGLE_LEGAL,
    scopes: [GOOGLE_SCOPES.tasks],
    examples: [
      '@Google Tasks What’s due this week?',
      '@Google Tasks Add tasks for everything I need to do before the trip, due Friday',
      '@Google Tasks Mark "renew passport" as done',
    ],
    guide: 'Google Tasks: tasks_list shows lists and tasks with IDs; due dates are dates only; tasks_update finds a task in any list, and deleting can’t be undone.',
    tools: [
      { name: 'tasks_list', title: 'See tasks', detail: 'Task lists and their tasks', icon: 'check-square' },
      { name: 'tasks_add', title: 'Add tasks', detail: 'With notes and due dates', write: true, icon: 'plus-square' },
      { name: 'tasks_update', title: 'Update tasks', detail: 'Edit, complete or delete tasks', write: true, icon: 'edit-3' },
    ],
  },

  // ---- Microsoft ----
  {
    id: 'outlook',
    provider: 'microsoft',
    title: 'Outlook',
    summary: 'Read and send Outlook mail',
    description: 'Use Outlook to search and summarize your mail, draft and send replies with attachments, and file messages into folders.',
    category: 'microsoft',
    popular: 6,
    website: 'https://outlook.com',
    ...MS_LEGAL,
    scopes: ['Mail.ReadWrite', 'Mail.Send'],
    examples: [
      '@Outlook Summarize the emails I got today and flag anything urgent',
      '@Outlook Draft a reply to the latest email from my manager confirming the deadline',
      '@Outlook Move all newsletters from this week into an Archive folder',
    ],
    guide: 'Outlook: outlook_search takes keywords or KQL (from:, subject:, hasAttachments:true); outlook_send drafts by default (send only when asked); moved messages get new IDs.',
    tools: [
      { name: 'outlook_search', title: 'Search mail', detail: 'Find messages in any folder', icon: 'search' },
      { name: 'outlook_read', title: 'Read mail', detail: 'Messages, with attachments saved to the workspace', icon: 'mail' },
      { name: 'outlook_send', title: 'Write mail', detail: 'Draft, send, reply and forward', write: true, icon: 'send' },
      { name: 'outlook_move', title: 'Organise mail', detail: 'Move, flag, mark read and delete', write: true, icon: 'folder' },
    ],
  },
  {
    id: 'outlook-calendar',
    provider: 'microsoft',
    title: 'Outlook Calendar',
    summary: 'Your Microsoft calendar',
    description: 'Use Outlook Calendar to check your schedule and create, update or cancel meetings, with attendees and Teams links.',
    category: 'microsoft',
    website: 'https://outlook.com/calendar',
    ...MS_LEGAL,
    scopes: ['Calendars.ReadWrite'],
    examples: [
      '@Outlook Calendar What meetings do I have tomorrow?',
      '@Outlook Calendar Schedule a 30-minute Teams call with sam@example.com next Tuesday morning',
      '@Outlook Calendar Cancel my 4pm meeting today and let the attendees know',
    ],
    guide: 'Outlook Calendar: look up an event with outlook_calendar_events before changing it; times use the user’s time zone.',
    tools: [
      { name: 'outlook_calendar_events', title: 'See events', detail: 'Events in a time range', icon: 'calendar' },
      { name: 'outlook_calendar_create', title: 'Create events', detail: 'With attendees and Teams links', write: true, icon: 'plus-square' },
      { name: 'outlook_calendar_update', title: 'Change events', detail: 'Move, edit, respond to or cancel', write: true, icon: 'edit-3' },
    ],
  },
  {
    id: 'onedrive',
    provider: 'microsoft',
    title: 'OneDrive',
    summary: 'Files in OneDrive',
    description: 'Use OneDrive to find your files, bring them into the chat to work on, and save files back, including Word, Excel and PowerPoint documents.',
    category: 'microsoft',
    website: 'https://onedrive.live.com',
    ...MS_LEGAL,
    scopes: ['Files.ReadWrite.All'],
    examples: [
      '@OneDrive Find my CV and suggest improvements',
      '@OneDrive Save the spreadsheet you made to my Documents folder',
      '@OneDrive What did I add to OneDrive last week?',
    ],
    guide: 'OneDrive: items can be IDs, paths like /Documents/cv.docx, or share links; onedrive_download saves files into the workspace under onedrive/; onedrive_upload saves workspace files to OneDrive.',
    tools: [
      { name: 'onedrive_search', title: 'Search files', detail: 'Find files and list folders', icon: 'search' },
      { name: 'onedrive_download', title: 'Download files', detail: 'Bring files into the workspace', icon: 'download-cloud' },
      { name: 'onedrive_upload', title: 'Upload files', detail: 'Save workspace files to OneDrive', write: true, icon: 'upload-cloud' },
      { name: 'onedrive_manage', title: 'Organise files', detail: 'Create folders, rename, move, copy and delete', write: true, icon: 'folder' },
    ],
  },
  {
    id: 'microsoft-todo',
    provider: 'microsoft',
    title: 'Microsoft To Do',
    summary: 'Lists and tasks',
    description: 'Use Microsoft To Do to see your lists and add, update and complete tasks with due dates and reminders.',
    category: 'microsoft',
    website: 'https://to-do.office.com',
    ...MS_LEGAL,
    scopes: ['Tasks.ReadWrite'],
    examples: [
      '@Microsoft To Do What’s on my list for today?',
      '@Microsoft To Do Add "book flights" with a reminder tomorrow at 9',
      '@Microsoft To Do Complete everything in my Groceries list',
    ],
    guide: 'Microsoft To Do: todo_list shows lists and tasks with IDs; due dates are date-only, and deleting can’t be undone.',
    tools: [
      { name: 'todo_list', title: 'See tasks', detail: 'Lists and their tasks', icon: 'check-square' },
      { name: 'todo_add', title: 'Add tasks', detail: 'With due dates and reminders', write: true, icon: 'plus-square' },
      { name: 'todo_update', title: 'Update tasks', detail: 'Edit, complete or delete tasks', write: true, icon: 'edit-3' },
    ],
  },

  // ---- Developer ----
  {
    id: 'github',
    provider: 'github',
    title: 'GitHub',
    summary: 'Repos, issues and pull requests',
    description: 'Use GitHub to search code and repositories, read files, follow issues and pull requests, and open issues, comment or commit files.',
    category: 'developer',
    popular: 5,
    website: 'https://github.com',
    privacy: 'https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement',
    terms: 'https://docs.github.com/site-policy/github-terms/github-terms-of-service',
    scopes: [],
    examples: [
      '@GitHub Summarize the open pull requests in my main repo and what each is waiting on',
      '@GitHub Open an issue for the bug we just found, with steps to reproduce',
      '@GitHub Read the README of facebook/react and explain how to contribute',
    ],
    guide: 'GitHub: name repos as owner/name (links to repos, issues, PRs and files work too); github_read reads files and folders at any ref; github_issues reads issues and PRs with their comments and diffs.',
    tools: [
      { name: 'github_search', title: 'Search', detail: 'Repositories, issues, pull requests and code', icon: 'search' },
      { name: 'github_read', title: 'Read repositories', detail: 'Files, folders and repo details', icon: 'file-text' },
      { name: 'github_issues', title: 'Read issues & PRs', detail: 'Lists, threads and diffs', icon: 'git-pull-request' },
      { name: 'github_write', title: 'Issues & comments', detail: 'Open, comment on, label and close', write: true, icon: 'message-square' },
      { name: 'github_commit', title: 'Commit files', detail: 'Create or update files on a branch', write: true, icon: 'git-commit' },
    ],
  },
  {
    id: 'linear',
    provider: 'linear',
    title: 'Linear',
    summary: 'Plan and track issues',
    description: 'Use Linear to find and read issues, create new ones, and update their status, priority and assignee, or comment on them.',
    category: 'developer',
    isNew: true,
    website: 'https://linear.app',
    privacy: 'https://linear.app/privacy',
    terms: 'https://linear.app/terms',
    scopes: [],
    examples: [
      '@Linear What issues are assigned to me and in progress?',
      '@Linear File a bug for the login crash in the Mobile team, high priority',
      '@Linear Move ENG-123 to Done and comment with a summary of the fix',
    ],
    guide: 'Linear (MCP): refer to issues by identifier (ENG-123); look up teams, states and users with the list tools before creating or updating issues.',
    tools: [],
  },
  {
    id: 'figma',
    provider: 'figma',
    title: 'Figma',
    summary: 'Inspect designs and comments',
    description: 'Use Figma to look through a file’s pages and frames, export frames as images to see or share them, and read or add comments.',
    category: 'developer',
    isNew: true,
    website: 'https://figma.com',
    privacy: 'https://www.figma.com/legal/privacy/',
    terms: 'https://www.figma.com/legal/tos/',
    scopes: [],
    examples: [
      '@Figma Export the frames on the first page of this file and describe the design: ',
      '@Figma Summarize the open comments on this file: ',
      '@Figma Write the CSS for the button component in this file: ',
    ],
    guide: 'Figma: pass file links; figma_read lists pages and frames with node IDs; figma_export saves frames as images you can look at with read_file.',
    tools: [
      { name: 'figma_read', title: 'Read files', detail: 'Pages, frames, components and styles', icon: 'layout' },
      { name: 'figma_export', title: 'Export images', detail: 'Frames as PNG, SVG or PDF in the workspace', icon: 'image' },
      { name: 'figma_comment', title: 'Comments', detail: 'Read comments and add new ones', write: true, icon: 'message-square' },
    ],
  },

  // ---- Productivity ----
  {
    id: 'notion',
    provider: 'notion',
    title: 'Notion',
    summary: 'Pages and databases',
    description:
      'Use Notion to search your workspace, read pages and databases, write new pages, and update properties or add to existing pages. Connects through Notion’s official MCP server: sign in and pick the pages to share.',
    category: 'productivity',
    popular: 4.5,
    website: 'https://notion.so',
    privacy: 'https://www.notion.so/notion/Privacy-Policy-3468d120cf614d4c9014c09f6adc9091',
    terms: 'https://www.notion.so/notion/Terms-and-Privacy-28ffdd083dc3473e9c2da6ec011b58ac',
    scopes: [],
    examples: [
      '@Notion Find my notes from the last planning meeting and list the action items',
      '@Notion Add a page to my Reading List database for the book we discussed',
      '@Notion Write up this chat as a new page under Projects',
    ],
    guide: 'Notion (MCP): search before reading or writing; page and database IDs come from search results; content is Notion-flavoured Markdown.',
    tools: [],
  },
  {
    id: 'todoist',
    provider: 'todoist',
    title: 'Todoist',
    summary: 'Tasks and projects',
    description: 'Use Todoist to see what’s due, add tasks with natural-language due dates, and complete, reschedule or reorganize them.',
    category: 'productivity',
    website: 'https://todoist.com',
    privacy: 'https://doist.com/privacy',
    terms: 'https://doist.com/terms-of-service',
    scopes: [],
    examples: [
      '@Todoist What’s due today and overdue?',
      '@Todoist Add "call the landlord" tomorrow at 10am, priority 1',
      '@Todoist Reschedule everything overdue to next Monday',
    ],
    guide: 'Todoist (MCP): due dates can be natural language; look up projects before adding tasks to them; deleting tasks can’t be undone.',
    tools: [],
  },
  {
    id: 'asana',
    provider: 'asana',
    title: 'Asana',
    summary: 'Team projects and tasks',
    description: 'Use Asana to see your tasks and projects, create tasks, and complete, reassign or comment on them.',
    category: 'productivity',
    website: 'https://asana.com',
    privacy: 'https://asana.com/terms/privacy-statement',
    terms: 'https://asana.com/terms',
    scopes: [],
    examples: [
      '@Asana What tasks are assigned to me this week?',
      '@Asana Create a task in the Launch project to review the press release by Friday',
      '@Asana Comment on the design review task that the mockups are ready',
    ],
    guide: 'Asana: asana_tasks finds workspaces, projects and tasks with their IDs; full-text search needs a paid Asana plan, otherwise it matches task names only.',
    tools: [
      { name: 'asana_tasks', title: 'See tasks', detail: 'My tasks, projects and task details', icon: 'check-square' },
      { name: 'asana_create', title: 'Create tasks', detail: 'In a project, with due date and assignee', write: true, icon: 'plus-square' },
      { name: 'asana_update', title: 'Update tasks', detail: 'Complete, edit, reassign and comment', write: true, icon: 'edit-3' },
    ],
  },
  {
    id: 'clickup',
    provider: 'clickup',
    title: 'ClickUp',
    summary: 'Tasks across your spaces',
    description: 'Use ClickUp to browse spaces and lists, find tasks, create new ones, and update status, assignees or comments.',
    category: 'productivity',
    website: 'https://clickup.com',
    privacy: 'https://clickup.com/privacy',
    terms: 'https://clickup.com/terms',
    scopes: [],
    examples: [
      '@ClickUp What’s in progress in the Marketing space?',
      '@ClickUp Create a task in Sprint 12 to fix the checkout bug',
      '@ClickUp Set the status of my oldest open task to complete',
    ],
    guide: 'ClickUp (MCP): find the workspace, space and list before creating tasks; deleting tasks can’t be undone.',
    tools: [],
  },
  {
    id: 'airtable',
    provider: 'airtable',
    title: 'Airtable',
    summary: 'Bases, tables and records',
    description: 'Use Airtable to explore your bases and tables, query records, and add, update or delete records.',
    category: 'productivity',
    website: 'https://airtable.com',
    privacy: 'https://www.airtable.com/company/privacy',
    terms: 'https://www.airtable.com/company/tos',
    scopes: [],
    examples: [
      '@Airtable What tables are in my CRM base and how many records does each have?',
      '@Airtable Add the three leads from this email to my Leads table',
      '@Airtable List the projects marked "At risk"',
    ],
    guide: 'Airtable: airtable_bases shows bases, tables and fields; use field names exactly as listed.',
    tools: [
      { name: 'airtable_bases', title: 'See bases', detail: 'Bases, tables and their fields', icon: 'database' },
      { name: 'airtable_records', title: 'Read records', detail: 'Filter, sort and read records', icon: 'list' },
      { name: 'airtable_write', title: 'Change records', detail: 'Create, update and delete records', write: true, icon: 'edit-3' },
    ],
  },

  // ---- Files ----
  {
    id: 'dropbox',
    provider: 'dropbox',
    title: 'Dropbox',
    summary: 'Files and shared links',
    description: 'Use Dropbox to find files, bring them into the chat to work on, save files back, and organize or share them with links.',
    category: 'files',
    website: 'https://dropbox.com',
    privacy: 'https://www.dropbox.com/privacy',
    terms: 'https://www.dropbox.com/terms',
    scopes: ['account_info.read', 'files.metadata.read', 'files.content.read', 'files.content.write', 'sharing.read', 'sharing.write'],
    examples: [
      '@Dropbox Find the signed contract PDF and summarize its key terms',
      '@Dropbox Save these photos to a new folder and give me a share link',
      '@Dropbox What’s in my Camera Uploads from last week?',
    ],
    guide: 'Dropbox: paths start with / (id:… and dropbox.com links work too); move and copy take the full destination path; dropbox_download saves files into the workspace under dropbox/.',
    tools: [
      { name: 'dropbox_search', title: 'Search files', detail: 'Find files and list folders', icon: 'search' },
      { name: 'dropbox_download', title: 'Download files', detail: 'Bring files into the workspace', icon: 'download-cloud' },
      { name: 'dropbox_upload', title: 'Upload files', detail: 'Save workspace files to Dropbox', write: true, icon: 'upload-cloud' },
      { name: 'dropbox_manage', title: 'Organise & share', detail: 'Folders, move, copy, delete and share links', write: true, icon: 'share-2' },
    ],
  },

  // ---- Lifestyle ----
  {
    id: 'spotify',
    provider: 'spotify',
    title: 'Spotify',
    summary: 'Music, playlists and playback',
    description: 'Use Spotify to search music, look at what you’ve been listening to, build playlists, and control playback on your devices (Premium).',
    category: 'lifestyle',
    isNew: true,
    website: 'https://spotify.com',
    privacy: 'https://www.spotify.com/legal/privacy-policy/',
    terms: 'https://www.spotify.com/legal/end-user-agreement/',
    scopes: [
      'user-read-private',
      'user-read-email',
      'user-top-read',
      'user-read-recently-played',
      'user-library-read',
      'playlist-read-private',
      'playlist-modify-private',
      'playlist-modify-public',
      'user-read-playback-state',
      'user-modify-playback-state',
    ],
    examples: [
      '@Spotify Make a playlist of upbeat songs for a long drive, based on what I listen to',
      '@Spotify What have I been listening to most this month?',
      '@Spotify Play something calm on my speaker',
    ],
    guide: 'Spotify: search returns at most 10 results per call (page with offset); playlist tracks are visible only for playlists the user owns or collaborates on; playback control needs Premium and an active device, and spotify_library lists devices.',
    tools: [
      { name: 'spotify_search', title: 'Search music', detail: 'Tracks, albums, artists and playlists', icon: 'search' },
      { name: 'spotify_library', title: 'Your music', detail: 'Top, recent, saved, playlists and devices', icon: 'music' },
      { name: 'spotify_playlist', title: 'Edit playlists', detail: 'Create playlists and add or remove tracks', write: true, icon: 'list' },
      { name: 'spotify_playback', title: 'Control playback', detail: 'Play, pause, skip and queue', write: true, icon: 'play-circle' },
    ],
  },
  {
    id: 'weather',
    provider: 'none',
    title: 'Weather',
    summary: 'Forecasts anywhere, no account',
    description: 'Use Weather for current conditions and hourly or 16-day forecasts for any place, from Open-Meteo. No account needed.',
    category: 'lifestyle',
    isNew: true,
    website: 'https://open-meteo.com',
    privacy: 'https://open-meteo.com/en/terms#privacy',
    terms: 'https://open-meteo.com/en/terms',
    scopes: [],
    examples: [
      '@Weather Will it rain in London this weekend?',
      '@Weather What should I pack for Tokyo next week?',
      '@Weather Hour-by-hour forecast for my run tomorrow morning in Singapore',
    ],
    guide: 'Weather: weather_forecast takes a place name or coordinates.',
    tools: [{ name: 'weather_forecast', title: 'Forecasts', detail: 'Current, hourly and daily weather', icon: 'cloud' }],
  },
  // ---- Hosted MCP servers (sign in with one tap; tools come from the server) ----
  {
    id: 'atlassian',
    provider: 'atlassian',
    title: 'Jira & Confluence',
    summary: 'Issues, projects and team pages',
    description:
      'Use Jira and Confluence to find and summarize issues and pages, create and update issues, and write or edit Confluence pages, through Atlassian’s official MCP server.',
    category: 'productivity',
    popular: 7,
    isNew: true,
    website: 'https://www.atlassian.com',
    privacy: 'https://www.atlassian.com/legal/privacy-policy',
    terms: 'https://www.atlassian.com/legal/cloud-terms-of-service',
    scopes: [],
    examples: [
      '@Jira & Confluence What Jira issues are assigned to me and still open?',
      '@Jira & Confluence Create a bug in the Mobile project for the crash we just found',
      '@Jira & Confluence Summarize the Confluence page about our release process',
    ],
    guide: 'Jira & Confluence (MCP): find the cloud site and project first; refer to issues by key (PROJ-123); search with JQL or CQL where the tools take it.',
    tools: [],
  },
  {
    id: 'miro',
    provider: 'miro',
    title: 'Miro',
    summary: 'Boards, diagrams and sticky notes',
    description: 'Use Miro to read your boards, and add sticky notes, shapes, diagrams and documents to them, through Miro’s official MCP server.',
    category: 'design',
    isNew: true,
    website: 'https://miro.com',
    privacy: 'https://miro.com/legal/privacy-policy/',
    terms: 'https://miro.com/legal/terms-of-service/',
    scopes: [],
    examples: [
      '@Miro Summarize the sticky notes on our retro board',
      '@Miro Draw a flowchart of the sign-up process on my planning board',
      '@Miro Turn this list of ideas into sticky notes grouped by theme: ',
    ],
    guide: 'Miro (MCP): find the board first; add items near existing content rather than at random positions.',
    tools: [],
  },
  {
    id: 'calendly',
    provider: 'calendly',
    title: 'Calendly',
    summary: 'Scheduling links and bookings',
    description: 'Use Calendly to see upcoming bookings and invitees, check your event types and availability, and share scheduling links, through Calendly’s official MCP server.',
    category: 'business',
    website: 'https://calendly.com',
    privacy: 'https://calendly.com/legal/privacy-notice',
    terms: 'https://calendly.com/legal/customer-terms-of-use',
    scopes: [],
    examples: [
      '@Calendly Who booked time with me this week?',
      '@Calendly Give me my 30-minute meeting link',
      '@Calendly Do I have any bookings tomorrow afternoon?',
    ],
    guide: 'Calendly (MCP): bookings are scheduled events; share scheduling links rather than booking on others’ behalf.',
    tools: [],
  },
  {
    id: 'granola',
    provider: 'granola',
    title: 'Granola',
    summary: 'Your meeting notes',
    description: 'Use Granola to search and read your meeting notes and transcripts, and pull out decisions and action items, through Granola’s official MCP server.',
    category: 'productivity',
    isNew: true,
    website: 'https://www.granola.ai',
    scopes: [],
    examples: [
      '@Granola What did we decide in yesterday’s product meeting?',
      '@Granola List my action items from this week’s meetings',
      '@Granola Draft a follow-up email from my last call with the client',
    ],
    guide: 'Granola (MCP): search meetings by title, person or date before reading their notes.',
    tools: [],
  },
  {
    id: 'jotform',
    provider: 'jotform',
    title: 'Jotform',
    summary: 'Forms and submissions',
    description: 'Use Jotform to list your forms, read and analyse submissions, and create forms, through Jotform’s official MCP server.',
    category: 'business',
    website: 'https://www.jotform.com',
    privacy: 'https://www.jotform.com/privacy/',
    terms: 'https://www.jotform.com/terms/',
    scopes: [],
    examples: [
      '@Jotform How many people signed up through my event form this week?',
      '@Jotform Summarize the feedback from my survey responses',
      '@Jotform Create a contact form with name, email and message fields',
    ],
    guide: 'Jotform (MCP): find the form before reading its submissions.',
    tools: [],
  },
  {
    id: 'attio',
    provider: 'attio',
    title: 'Attio',
    summary: 'CRM records and notes',
    description: 'Use Attio to look up companies, people and deals, add notes and tasks, and update records, through Attio’s official MCP server.',
    category: 'business',
    website: 'https://attio.com',
    scopes: [],
    examples: [
      '@Attio What do we know about Acme Corp and who is our contact there?',
      '@Attio Add a note to Jane Doe’s record about today’s call',
      '@Attio List deals that are in negotiation',
    ],
    guide: 'Attio (MCP): search for a record before updating it; keep notes factual.',
    tools: [],
  },
  {
    id: 'make',
    provider: 'make',
    title: 'Make',
    summary: 'Run your automations',
    description: 'Use Make to list and run your scenarios, so agents can trigger the automations you’ve already built, through Make’s official MCP server.',
    category: 'business',
    website: 'https://www.make.com',
    privacy: 'https://www.make.com/en/privacy-notice',
    terms: 'https://www.make.com/en/terms-and-conditions',
    scopes: [],
    examples: [
      '@Make Which scenarios do I have?',
      '@Make Run my “daily report” scenario',
      '@Make Did my invoice automation run successfully today?',
    ],
    guide: 'Make (MCP): running a scenario has real effects; confirm which one with the user first.',
    tools: [],
  },
  {
    id: 'paypal',
    provider: 'paypal',
    title: 'PayPal',
    summary: 'Invoices, orders and transactions',
    description: 'Use PayPal to look up transactions, create and send invoices, and track orders and disputes, through PayPal’s official MCP server.',
    category: 'business',
    website: 'https://www.paypal.com',
    privacy: 'https://www.paypal.com/myaccount/privacy/privacyhub',
    terms: 'https://www.paypal.com/legalhub/useragreement-full',
    scopes: [],
    examples: [
      '@PayPal What payments did I receive this week?',
      '@PayPal Draft an invoice for 3 hours of consulting at $80 an hour',
      '@PayPal Are there any open disputes?',
    ],
    guide: 'PayPal (MCP): money moves are real; always confirm amounts and recipients with the user before creating or sending anything.',
    tools: [],
  },
  {
    id: 'sentry',
    provider: 'sentry',
    title: 'Sentry',
    summary: 'Errors and performance issues',
    description: 'Use Sentry to find and investigate errors in your apps, read stack traces and events, and update issues, through Sentry’s official MCP server.',
    category: 'developer',
    isNew: true,
    website: 'https://sentry.io',
    privacy: 'https://sentry.io/privacy/',
    terms: 'https://sentry.io/terms/',
    scopes: [],
    examples: [
      '@Sentry What are the most frequent errors in my app this week?',
      '@Sentry Explain the latest crash and suggest a fix',
      '@Sentry Resolve the issue we just fixed',
    ],
    guide: 'Sentry (MCP): find the organization and project first; quote the key frames of stack traces when explaining errors.',
    tools: [],
  },
  {
    id: 'supabase',
    provider: 'supabase',
    title: 'Supabase',
    summary: 'Databases, tables and SQL',
    description: 'Use Supabase to explore your projects and tables, run SQL, read logs, and manage migrations, through Supabase’s official MCP server.',
    category: 'developer',
    website: 'https://supabase.com',
    privacy: 'https://supabase.com/privacy',
    terms: 'https://supabase.com/terms',
    scopes: [],
    examples: [
      '@Supabase What tables are in my project and how many rows do they have?',
      '@Supabase Write and run a query for sign-ups per day this month',
      '@Supabase Check the logs for errors in the last hour',
    ],
    guide: 'Supabase (MCP): read the schema before writing SQL; ask before running anything that changes data or schema.',
    tools: [],
  },
  {
    id: 'netlify',
    provider: 'netlify',
    title: 'Netlify',
    summary: 'Sites and deploys',
    description: 'Use Netlify to see your sites and deploys, check build status, and manage site settings, through Netlify’s official MCP server.',
    category: 'developer',
    website: 'https://www.netlify.com',
    privacy: 'https://www.netlify.com/privacy/',
    terms: 'https://www.netlify.com/legal/terms-of-use/',
    scopes: [],
    examples: [
      '@Netlify Did my last deploy succeed?',
      '@Netlify List my sites and their URLs',
      '@Netlify Why did the latest build fail?',
    ],
    guide: 'Netlify (MCP): find the site first; ask before changing settings or deploying.',
    tools: [],
  },
  {
    id: 'neon',
    provider: 'neon',
    title: 'Neon',
    summary: 'Serverless Postgres',
    description: 'Use Neon to explore your Postgres projects, branches and tables, and run SQL, through Neon’s official MCP server.',
    category: 'developer',
    website: 'https://neon.com',
    privacy: 'https://neon.com/privacy-policy',
    terms: 'https://neon.com/terms-of-service',
    scopes: [],
    examples: [
      '@Neon What databases and branches do I have?',
      '@Neon Show the schema of my users table',
      '@Neon How many orders were placed yesterday?',
    ],
    guide: 'Neon (MCP): read the schema before writing SQL; ask before running anything that changes data or schema.',
    tools: [],
  },
  {
    id: 'huggingface',
    provider: 'huggingface',
    title: 'Hugging Face',
    summary: 'Models, datasets and Spaces',
    description: 'Use Hugging Face to search models, datasets, papers and Spaces, and read their details, through Hugging Face’s official MCP server.',
    category: 'developer',
    website: 'https://huggingface.co',
    privacy: 'https://huggingface.co/privacy',
    terms: 'https://huggingface.co/terms-of-service',
    scopes: [],
    examples: [
      '@Hugging Face Find a small open model for summarizing text',
      '@Hugging Face What are the most popular speech-to-text datasets?',
      '@Hugging Face Find recent papers on small language models',
    ],
    guide: 'Hugging Face (MCP): link to the model, dataset or Space pages you mention.',
    tools: [],
  },
  {
    id: 'webflow',
    provider: 'webflow',
    title: 'Webflow',
    summary: 'Sites, pages and CMS content',
    description: 'Use Webflow to read and update your sites’ pages and CMS collections, and publish changes, through Webflow’s official MCP server.',
    category: 'design',
    website: 'https://webflow.com',
    privacy: 'https://webflow.com/legal/privacy',
    terms: 'https://webflow.com/legal/terms',
    scopes: [],
    examples: [
      '@Webflow Add a new blog post to my site’s CMS from this draft: ',
      '@Webflow List the pages on my site',
      '@Webflow Fix the typos in my homepage text',
    ],
    guide: 'Webflow (MCP): find the site and collection first; ask before publishing.',
    tools: [],
  },
  {
    id: 'wix',
    provider: 'wix',
    title: 'Wix',
    summary: 'Your Wix sites and business',
    description: 'Use Wix to manage your Wix sites: content, products, bookings and more, through Wix’s official MCP server.',
    category: 'design',
    website: 'https://www.wix.com',
    privacy: 'https://www.wix.com/about/privacy',
    terms: 'https://www.wix.com/about/terms-of-use',
    scopes: [],
    examples: [
      '@Wix What products are in my store and which are low on stock?',
      '@Wix Write a new blog post for my site about our opening hours',
      '@Wix Show this week’s bookings',
    ],
    guide: 'Wix (MCP): find the site first; ask before publishing or changing store data.',
    tools: [],
  },
  {
    id: 'excalidraw',
    provider: 'excalidraw',
    title: 'Excalidraw',
    summary: 'Hand-drawn diagrams, no account',
    description: 'Use Excalidraw to sketch diagrams, flowcharts and wireframes in its hand-drawn style, through Excalidraw’s official MCP server. No account needed.',
    category: 'design',
    isNew: true,
    website: 'https://excalidraw.com',
    scopes: [],
    examples: [
      '@Excalidraw Sketch the architecture of a simple web app',
      '@Excalidraw Draw a flowchart for making coffee',
      '@Excalidraw Wireframe a login screen',
    ],
    guide: 'Excalidraw (MCP): give the user the link to the drawing you make.',
    tools: [],
  },
  {
    id: 'deepwiki',
    provider: 'deepwiki',
    title: 'DeepWiki',
    summary: 'Ask about any public GitHub repo',
    description: 'Use DeepWiki to read AI-written documentation for public GitHub repositories and ask questions about how they work. No account needed.',
    category: 'developer',
    website: 'https://deepwiki.com',
    scopes: [],
    examples: [
      '@DeepWiki How does routing work in expo/expo?',
      '@DeepWiki Give me an overview of the architecture of facebook/react',
      '@DeepWiki Where is authentication handled in supabase/supabase?',
    ],
    guide: 'DeepWiki (MCP): name repositories as owner/name.',
    tools: [],
  },
  {
    id: 'context7',
    provider: 'context7',
    title: 'Context7',
    summary: 'Up-to-date library docs',
    description: 'Use Context7 to pull current documentation and code examples for programming libraries, so answers match the version you use.',
    category: 'developer',
    website: 'https://context7.com',
    scopes: [],
    examples: [
      '@Context7 How do I set up routing in the latest Expo Router?',
      '@Context7 Show the current API for Zustand persist middleware',
      '@Context7 What changed in React 19 for forms?',
    ],
    guide: 'Context7 (MCP): resolve the library ID first, then fetch its docs on the topic asked about.',
    tools: [],
  },
];

export const pluginById = (id: string) => PLUGINS.find((p) => p.id === id);

/** Whether the plugin's tools come from a hosted MCP server. */
export const isMcpPlugin = (plugin: PluginDef) => PROVIDERS[plugin.provider].auth.kind === 'mcp';

/**
 * A plugin's tools: its own, or for an MCP plugin the ones its server listed last (none before it
 * is connected). Tools the server marks read-only don't count as making changes.
 */
export function pluginTools(plugin: PluginDef): PluginTool[] {
  if (!isMcpPlugin(plugin)) return plugin.tools;
  return (usePlugins.getState().mcp[plugin.provider]?.tools ?? []).map((t) => ({
    name: t.key,
    title: t.title,
    detail: t.description.split(/(?<=[.!?])\s/)[0].slice(0, 160),
    write: !t.readOnly,
  }));
}

export const pluginOfTool = (tool: string) => PLUGINS.find((p) => pluginTools(p).some((t) => t.name === tool));

export const popularPlugins = () => PLUGINS.filter((p) => p.popular != null).sort((a, b) => a.popular! - b.popular!);

export const newPlugins = () => PLUGINS.filter((p) => p.isNew);

/** Scope names compare without Microsoft's Graph prefix or case. */
export const normalizeScope = (s: string) => s.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase();

/** Whether the provider's account granted what the plugin needs (consent screens let people untick some). */
export function pluginGranted(plugin: PluginDef) {
  if (plugin.provider === 'none') return true;
  const account = usePlugins.getState().accounts[plugin.provider];
  if (!account) return false;
  const granted = new Set(account.scopes.map(normalizeScope));
  return plugin.scopes.every((s) => granted.has(normalizeScope(s)));
}

/** Installed, signed in, granted, and not waiting to be reconnected. */
export function pluginReady(plugin: PluginDef) {
  const { installed, accounts } = usePlugins.getState();
  if (!installed[plugin.id]) return false;
  if (plugin.provider === 'none') return true;
  const account = accounts[plugin.provider];
  return !!account && !account.needsReconnect && pluginGranted(plugin);
}

export const pluginWrites = (plugin: PluginDef) => usePlugins.getState().installed[plugin.id]?.write ?? true;

/** Whether the model is offered the named plugin tool. */
export function pluginToolOn(name: string) {
  const plugin = pluginOfTool(name);
  if (!plugin || !pluginReady(plugin)) return false;
  return !pluginTools(plugin).find((t) => t.name === name)?.write || pluginWrites(plugin);
}

/** Whether an account granted a scope, for tools that do better with another plugin's access. */
export const hasScope = (provider: ProviderId, scope: string) =>
  !!usePlugins.getState().accounts[provider]?.scopes.some((s) => normalizeScope(s) === normalizeScope(scope));
